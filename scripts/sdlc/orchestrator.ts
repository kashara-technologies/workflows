// Kashara SDLC orchestrator entry point.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCoder } from './agents/coder.js';
import { runPlanner } from './agents/planner.js';
import { runReviewer } from './agents/reviewer.js';
import { runTester } from './agents/tester.js';
import { OPUS_MODEL_ID } from './lib/anthropic.js';
import { createAuditLogger } from './lib/audit.js';
import { getMonthlyAgentCost } from './lib/budget.js';
import { getEnv } from './lib/env.js';
import { emitPipelineRunCompleted, shutdownPostHog } from './lib/posthog.js';
import { commitAndPushBuildBranch, prepareBuildBranch } from './lib/git.js';
import { assertCanWriteToRepo } from './lib/github-app.js';
import { checkIdempotency } from './lib/idempotency.js';
import {
  convertPrToDraft,
  findOrCreateBuildPr,
  markPrReadyForReview,
  postPrComment,
  setBuildLabel,
  updatePrBody,
} from './lib/github-pr.js';
import { log } from './lib/logger.js';
import {
  buildPrBody,
  coderRetryComment,
  finalComment,
  milestoneComment,
  type FinalDecision,
} from './lib/pr-comments.js';
import { buildRunContext, parsePrdPath } from './lib/run-context.js';
import { getSupabase } from './lib/supabase.js';

const MAX_CODER_RETRIES = 3;

async function main(): Promise<void> {
  log.info('Kashara SDLC orchestrator starting');

  const env = getEnv();
  log.info('Env validated', {
    repo: env.GITHUB_REPOSITORY,
    targetRepoPath: env.TARGET_REPO_PATH,
  });

  const prdPath = process.argv[2] ?? process.env.PRD_PATH;
  if (!prdPath) {
    log.error('No PRD path provided. Pass as first arg or PRD_PATH env var.');
    process.exit(1);
  }
  log.info('PRD path', { prdPath });

  const { product, feature } = parsePrdPath(prdPath);
  log.info('Parsed PRD', { product, feature });

  const absolutePrdPath = path.join(env.TARGET_REPO_PATH, prdPath);
  if (!existsSync(absolutePrdPath)) {
    log.error('PRD file not found on disk', { absolutePrdPath });
    process.exit(1);
  }

  const ctx = buildRunContext(prdPath);
  log.info('Run context built', {
    pipelineRunId: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
    buildBranch: ctx.buildBranch,
  });

  try {
    const sb = getSupabase();
    const { error } = await sb.from('agent_runs').select('id').limit(1);
    if (error) {
      log.warn('Supabase query returned error (table may be empty)', { error: error.message });
    } else {
      log.info('Supabase connection verified');
    }
  } catch (err) {
    log.error('Supabase connection failed', { error: (err as Error).message });
    process.exit(1);
  }

  // Opt-in monthly kill switch. When SDLC_MONTHLY_KILL_SWITCH_USD is set,
  // check current calendar month spend before doing anything else. Over the
  // limit: drop a critical marker for the Slack alert step and exit.
  await checkMonthlyKillSwitch();

  // Fail fast if the App can't push the artifacts, before burning Anthropic
  // credit on the agents.
  await assertCanWriteToRepo(env.GITHUB_REPOSITORY);

  // Idempotency: if the same PRD content was already approved on this build
  // branch, skip the full pipeline. Saves the ~$12 cost of re-running a
  // duplicate trigger. Bypass with SDLC_FORCE_RERUN=1.
  const idempotency = await checkIdempotency({
    feature: ctx.feature,
    buildBranch: ctx.buildBranch,
    prdContentSha: ctx.prdContentSha,
  });
  if (idempotency.shouldSkip) {
    log.info('Skipping pipeline (idempotent)', {
      feature: ctx.feature,
      prdContentSha: ctx.prdContentSha,
      reason: idempotency.reason,
    });
    await writeIdempotentSkipSummary({
      feature: ctx.feature,
      product: ctx.product,
      branch: ctx.buildBranch,
      repo: env.GITHUB_REPOSITORY,
      reason: idempotency.reason,
      previousShippedAt: idempotency.previous?.shippedAt ?? null,
    });
    return;
  }
  log.info('Idempotency check: proceeding', { reason: idempotency.reason });

  // Set up the build branch fresh from main. Every artifact and code file the
  // agents produce lands on top of this branch.
  await prepareBuildBranch({ repoPath: ctx.repoPath, branch: ctx.buildBranch });

  const audit = createAuditLogger(ctx.artifactsPath);
  const artifactsRelDir = path.relative(ctx.repoPath, ctx.artifactsPath);

  // Bootstrap commit: write run.json (per design doc section 4) so the build
  // branch differs from main. Without this, the PR-create endpoint fails with
  // "No commits between main and build/auth".
  await writeRunJson(ctx);
  await commitAndPushBuildBranch({
    repoPath: ctx.repoPath,
    branch: ctx.buildBranch,
    message: `chore(build): initialize ${ctx.feature} pipeline run ${ctx.pipelineRunId.slice(0, 8)}`,
  });

  const buildPr = await findOrCreateBuildPr({
    branch: ctx.buildBranch,
    baseBranch: 'main',
    feature: ctx.feature,
    initialBody: buildPrBody({
      feature: ctx.feature,
      product: ctx.product,
      pipelineRunId: ctx.pipelineRunId,
      repo: env.GITHUB_REPOSITORY,
      branch: ctx.buildBranch,
      artifactDir: artifactsRelDir,
      decision: 'in_progress',
    }),
  });
  await setBuildLabel({ prNumber: buildPr.number, label: 'build:planning' });

  let pipelineSucceeded = false;
  let terminalDecision: FinalDecision | 'in_progress' = 'in_progress';
  let reviewerRationale: string | undefined;
  let totalCostUsd = 0;
  let totalTurns = 0;
  let retriesUsed = 0;
  let agentCount = 0;
  const pipelineStartedAtMs = Date.now();

  try {
    // --- Planner ---
    const planner = await runPlanner(ctx);
    totalCostUsd += planner.agentResult.costUsd;
    totalTurns += planner.agentResult.turns;
    agentCount += 1;
    log.info('Planner stage complete', {
      planPath: planner.planPath,
      turns: planner.agentResult.turns,
      costUsd: planner.agentResult.costUsd,
    });
    const planRelPath = path.relative(ctx.repoPath, planner.planPath);

    await postPrComment({
      prNumber: buildPr.number,
      body: milestoneComment({
        agent: 'planner',
        model: OPUS_MODEL_ID,
        agentResult: planner.agentResult,
        artifactPath: planRelPath,
        repo: env.GITHUB_REPOSITORY,
        branch: ctx.buildBranch,
      }),
    });
    await setBuildLabel({ prNumber: buildPr.number, label: 'build:coding' });

    // --- Coder + Tester retry loop ---
    let lastTestResultsRelPath: string | undefined;
    let lastSummaryRelPath: string | undefined;
    let testerPassed = false;

    for (let attempt = 0; attempt <= MAX_CODER_RETRIES; attempt++) {
      // Coder.
      const coder = await runCoder({
        ctx,
        audit,
        planRelPath,
        previousTestResultsRelPath: lastTestResultsRelPath,
        retryCount: attempt,
      });
      const summaryRelPath = path.relative(ctx.repoPath, coder.summaryPath);
      lastSummaryRelPath = summaryRelPath;
      totalCostUsd += coder.agentResult.costUsd;
      totalTurns += coder.agentResult.turns;
      agentCount += 1;
      log.info('Coder stage complete', {
        attempt,
        summaryPath: coder.summaryPath,
        turns: coder.agentResult.turns,
        costUsd: coder.agentResult.costUsd,
      });
      await postPrComment({
        prNumber: buildPr.number,
        body: milestoneComment({
          agent: 'coder',
          model: OPUS_MODEL_ID,
          agentResult: coder.agentResult,
          artifactPath: summaryRelPath,
          repo: env.GITHUB_REPOSITORY,
          branch: ctx.buildBranch,
          tagline: attempt === 0 ? undefined : `Retry attempt ${attempt} of ${MAX_CODER_RETRIES}.`,
        }),
      });
      await setBuildLabel({ prNumber: buildPr.number, label: 'build:testing' });

      // Tester.
      const tester = await runTester({
        ctx,
        audit,
        planRelPath,
        summaryRelPath,
      });
      lastTestResultsRelPath = path.relative(ctx.repoPath, tester.testResultsPath);
      totalCostUsd += tester.agentResult.costUsd;
      totalTurns += tester.agentResult.turns;
      agentCount += 1;
      log.info('Tester stage complete', {
        attempt,
        testResultsPath: tester.testResultsPath,
        decision: tester.decision,
        turns: tester.agentResult.turns,
        costUsd: tester.agentResult.costUsd,
      });
      await postPrComment({
        prNumber: buildPr.number,
        body: milestoneComment({
          agent: 'tester',
          model: OPUS_MODEL_ID,
          agentResult: tester.agentResult,
          artifactPath: lastTestResultsRelPath,
          repo: env.GITHUB_REPOSITORY,
          branch: ctx.buildBranch,
          tagline: `Decision: **${tester.decision}**`,
        }),
      });

      if (tester.decision === 'PASS') {
        testerPassed = true;
        await setBuildLabel({ prNumber: buildPr.number, label: 'build:reviewing' });
        break;
      }
      if (tester.decision === 'UNKNOWN') {
        log.warn('Tester decision unparseable; treating as FAIL for retry purposes', {
          attempt,
        });
      }
      if (attempt === MAX_CODER_RETRIES) {
        terminalDecision = 'fail';
        log.warn('Tester FAIL on final attempt; pipeline ends with failure', { attempt });
        await setBuildLabel({ prNumber: buildPr.number, label: 'build:failed' });
        await writeCriticalRetryMarker({
          feature: ctx.feature,
          product: ctx.product,
          pipelineRunId: ctx.pipelineRunId,
          retriesUsed: MAX_CODER_RETRIES,
          prUrl: buildPr.htmlUrl,
        });
        break;
      }
      retriesUsed = attempt + 1;
      await postPrComment({
        prNumber: buildPr.number,
        body: coderRetryComment({
          attemptNumber: attempt + 1,
          maxRetries: MAX_CODER_RETRIES,
          failureSummary: 'See test results above for details.',
        }),
      });
      await setBuildLabel({ prNumber: buildPr.number, label: 'build:coding' });
      log.info('Tester FAIL; entering coder retry', { nextAttempt: attempt + 1 });
    }

    // --- Reviewer (only when tester passed) ---
    if (testerPassed && lastSummaryRelPath && lastTestResultsRelPath) {
      const reviewer = await runReviewer({
        ctx,
        planRelPath,
        summaryRelPath: lastSummaryRelPath,
        testResultsRelPath: lastTestResultsRelPath,
      });
      const reviewRelPath = path.relative(ctx.repoPath, reviewer.reviewPath);
      totalCostUsd += reviewer.agentResult.costUsd;
      totalTurns += reviewer.agentResult.turns;
      agentCount += 1;
      log.info('Reviewer stage complete', {
        reviewPath: reviewer.reviewPath,
        decision: reviewer.decision,
        rationale: reviewer.decisionRationale,
        turns: reviewer.agentResult.turns,
        costUsd: reviewer.agentResult.costUsd,
      });
      await postPrComment({
        prNumber: buildPr.number,
        body: milestoneComment({
          agent: 'reviewer',
          model: OPUS_MODEL_ID,
          agentResult: reviewer.agentResult,
          artifactPath: reviewRelPath,
          repo: env.GITHUB_REPOSITORY,
          branch: ctx.buildBranch,
          tagline: `Decision: **${reviewer.decision}**${reviewer.decisionRationale ? ` , ${reviewer.decisionRationale}` : ''}`,
        }),
      });

      reviewerRationale = reviewer.decisionRationale || undefined;
      if (reviewer.decision === 'APPROVE') {
        terminalDecision = 'approved';
        pipelineSucceeded = true;
        await setBuildLabel({ prNumber: buildPr.number, label: 'build:approved' });
      } else {
        // BLOCK or UNKNOWN both end up blocked. UNKNOWN is treated as BLOCK
        // out of caution; the human must look at 04-review.md to disambiguate.
        terminalDecision = 'blocked';
        await setBuildLabel({ prNumber: buildPr.number, label: 'build:blocked' });
      }
    }
  } catch (err) {
    log.error('Pipeline stage threw', { error: (err as Error).message, stack: (err as Error).stack });
    try {
      await setBuildLabel({ prNumber: buildPr.number, label: 'build:failed' });
    } catch {
      // best effort; don't mask the original error
    }
    throw err;
  } finally {
    // Refresh run.json with the terminal decision + shipped_at before the
    // final commit so the next pipeline run can read it for the idempotency
    // check.
    try {
      await writeRunJson(ctx, {
        decision: terminalDecision,
        shippedAt: terminalDecision === 'approved' ? new Date().toISOString() : undefined,
      });
    } catch (err) {
      log.warn('Failed to refresh run.json with terminal decision', {
        error: (err as Error).message,
      });
    }

    // Commit and push whatever the agents wrote, even on partial failure.
    const decisionLabel =
      terminalDecision === 'in_progress' ? 'unknown' : terminalDecision;
    const message =
      `chore(build): pipeline run, decision=${decisionLabel} for ${ctx.feature}\n\n` +
      `Pipeline run ${ctx.pipelineRunId}.`;
    const pushResult = await commitAndPushBuildBranch({
      repoPath: ctx.repoPath,
      branch: ctx.buildBranch,
      message,
    });
    log.info('Build branch pushed', {
      branch: pushResult.branch,
      commitSha: pushResult.commitSha,
      committed: pushResult.committed,
      terminalDecision,
    });

    // Update PR description with final state + reviewer rationale.
    try {
      await updatePrBody({
        prNumber: buildPr.number,
        body: buildPrBody({
          feature: ctx.feature,
          product: ctx.product,
          pipelineRunId: ctx.pipelineRunId,
          repo: env.GITHUB_REPOSITORY,
          branch: ctx.buildBranch,
          artifactDir: artifactsRelDir,
          decision: terminalDecision,
          reviewerRationale,
          totalCostUsd,
          retriesUsed,
        }),
      });
    } catch (err) {
      log.warn('Failed to update PR body', { error: (err as Error).message });
    }

    // Final summary comment, only when we reached a terminal state.
    if (terminalDecision !== 'in_progress') {
      try {
        await postPrComment({
          prNumber: buildPr.number,
          body: finalComment({
            decision: terminalDecision,
            feature: ctx.feature,
            repo: env.GITHUB_REPOSITORY,
            branch: ctx.buildBranch,
            artifactDir: artifactsRelDir,
            commitSha: pushResult.commitSha,
            totalCostUsd,
            totalTurns,
            retriesUsed,
            reviewerRationale,
          }),
        });
      } catch (err) {
        log.warn('Failed to post final PR comment', { error: (err as Error).message });
      }
    }

    // Draft state transitions.
    try {
      if (terminalDecision === 'approved') {
        await markPrReadyForReview(buildPr.number);
      } else if (terminalDecision === 'blocked' || terminalDecision === 'fail') {
        await convertPrToDraft(buildPr.number);
      }
    } catch (err) {
      log.warn('Failed to update PR draft state', { error: (err as Error).message });
    }

    // PostHog summary event for the whole pipeline run, then flush the queue
    // so events are delivered before the runner terminates.
    if (terminalDecision !== 'in_progress') {
      emitPipelineRunCompleted({
        pipelineRunId: ctx.pipelineRunId,
        product: ctx.product,
        feature: ctx.feature,
        outcome:
          terminalDecision === 'approved'
            ? 'approved'
            : terminalDecision === 'blocked'
              ? 'blocked'
              : 'failed',
        totalCostUsd,
        totalDurationMs: Date.now() - pipelineStartedAtMs,
        agentCount,
        retriesUsed,
      });
    }
    await shutdownPostHog();
  }

  log.info('Phase F pipeline complete.', {
    pipelineRunId: ctx.pipelineRunId,
    succeeded: pipelineSucceeded,
    terminalDecision,
    totalCostUsd,
    totalTurns,
    retriesUsed,
    agentCount,
  });

  // Write a human-readable summary to $GITHUB_STEP_SUMMARY so the GH Actions
  // run page distinguishes "BLOCKED (advisory, PR in draft)" from "crashed"
  // at a glance. Both exit code 1 today, but the summary makes the cause
  // obvious without reading logs.
  await writeStepSummary({
    terminalDecision,
    feature: ctx.feature,
    product: ctx.product,
    repo: env.GITHUB_REPOSITORY,
    branch: ctx.buildBranch,
    pipelineRunId: ctx.pipelineRunId,
    totalCostUsd,
    totalTurns,
    retriesUsed,
    reviewerRationale,
  });

  if (!pipelineSucceeded) {
    process.exit(1);
  }
}

interface StepSummaryParams {
  terminalDecision: FinalDecision | 'in_progress';
  feature: string;
  product: string;
  repo: string;
  branch: string;
  pipelineRunId: string;
  totalCostUsd: number;
  totalTurns: number;
  retriesUsed: number;
  reviewerRationale: string | undefined;
}

/**
 * Append a Markdown summary to $GITHUB_STEP_SUMMARY so the GH Actions run
 * page shows the outcome at a glance. A red run for BLOCK reads identical
 * to a red run for a crash; this writes "BLOCKED (advisory)" or "CRASHED"
 * or "APPROVED" into the run summary so the difference is obvious.
 */
async function writeStepSummary(params: StepSummaryParams): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const { appendFile } = await import('node:fs/promises');
  const headline = (() => {
    switch (params.terminalDecision) {
      case 'approved':
        return '✅ **APPROVED** , PR is ready for human merge.';
      case 'blocked':
        return '⚠️ **BLOCKED by reviewer** (advisory). PR is in draft; read `04-review.md` for the block reason and resolve before merging.';
      case 'fail':
        return '❌ **FAILED**, tester could not pass after retries. PR is in draft. Read `03-test-results.md` for the failing checks.';
      case 'in_progress':
        return '❓ **Pipeline did not reach a terminal state.** Likely a crash before reviewer ran.';
    }
  })();
  const body = [
    `## SDLC pipeline result`,
    ``,
    headline,
    ``,
    `**Feature:** \`${params.feature}\` (${params.product})`,
    `**Run ID:** \`${params.pipelineRunId}\``,
    `**Build branch:** [\`${params.branch}\`](https://github.com/${params.repo}/tree/${params.branch})`,
    `**Cost:** $${params.totalCostUsd.toFixed(2)} across ${params.totalTurns} turns, ${params.retriesUsed} retr${params.retriesUsed === 1 ? 'y' : 'ies'}`,
    params.reviewerRationale ? `\n**Reviewer note:** ${params.reviewerRationale}` : '',
    ``,
    `> Tip: a red status on a BLOCKED run is expected. The reviewer found something worth a second look; check \`04-review.md\` and the PR before re-running.`,
    ``,
  ]
    .filter((l) => l !== null)
    .join('\n');
  await appendFile(summaryPath, body, 'utf-8');
}

interface WriteRunJsonExtras {
  /** Terminal pipeline outcome. Used by the idempotency check on the next run. */
  decision?: FinalDecision | 'in_progress';
  /** ISO timestamp when the terminal decision was reached. */
  shippedAt?: string;
}

async function writeRunJson(
  ctx: ReturnType<typeof buildRunContext>,
  extras: WriteRunJsonExtras = {},
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(ctx.artifactsPath, { recursive: true });
  const body: Record<string, unknown> = {
    run_id: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
    prd_path: ctx.prdPath,
    prd_sha: ctx.prdSha,
    prd_content_sha: ctx.prdContentSha,
    repo: ctx.repo,
    repo_sha: ctx.repoSha,
    build_branch: ctx.buildBranch,
    started_at: ctx.startedAt,
    decision: extras.decision ?? 'in_progress',
  };
  if (extras.shippedAt) body.shipped_at = extras.shippedAt;
  await writeFile(
    path.join(ctx.artifactsPath, 'run.json'),
    JSON.stringify(body, null, 2) + '\n',
    'utf-8',
  );
}

interface IdempotentSkipSummaryParams {
  feature: string;
  product: string;
  repo: string;
  branch: string;
  reason: string;
  previousShippedAt: string | null;
}

async function writeIdempotentSkipSummary(params: IdempotentSkipSummaryParams): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const { appendFile } = await import('node:fs/promises');
  const body = [
    `## SDLC pipeline result`,
    ``,
    `⏭️ **Skipped (idempotent).** Same PRD content was already approved on this build branch.`,
    ``,
    `**Feature:** \`${params.feature}\` (${params.product})`,
    `**Build branch:** [\`${params.branch}\`](https://github.com/${params.repo}/tree/${params.branch})`,
    `**Reason:** ${params.reason}`,
    params.previousShippedAt ? `**Previous APPROVED at:** ${params.previousShippedAt}` : '',
    ``,
    `Set the repo variable \`SDLC_FORCE_RERUN\` to \`1\` (or env var of the same name) to bypass this check on the next run.`,
    ``,
  ]
    .filter((l) => l !== '')
    .join('\n');
  await appendFile(summaryPath, body, 'utf-8');
}

interface CriticalRetryMarkerPayload {
  feature: string;
  product: string;
  pipelineRunId: string;
  retriesUsed: number;
  prUrl: string;
}

/**
 * Drop `.coder-retries-exhausted` into $GITHUB_WORKSPACE so the Slack alert
 * step in sdlc-pipeline.yml routes to `#alerts-critical`. Everything else
 * falls back to the warning channel.
 *
 * Only called from the retry-exhaustion branch; orchestrator crashes from
 * other causes (API errors, network, etc.) stay at warning severity.
 */
async function writeCriticalRetryMarker(payload: CriticalRetryMarkerPayload): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    log.warn('GITHUB_WORKSPACE not set; cannot write coder-retries-exhausted marker');
    return;
  }
  const markerPath = path.join(workspace, '.coder-retries-exhausted');
  await writeFile(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  log.info('Wrote coder-retries-exhausted marker for critical Slack routing', {
    markerPath,
    feature: payload.feature,
    pipelineRunId: payload.pipelineRunId,
  });
}

/**
 * Opt-in monthly cost circuit breaker. Reads SDLC_MONTHLY_KILL_SWITCH_USD
 * from env; if unset, no-op. If set and current month spend in agent_runs is
 * over that value, writes .budget-kill-switch-tripped into $GITHUB_WORKSPACE
 * so the pipeline workflow routes a critical Slack alert, and exits non-zero
 * before starting any agent. Running pipelines on other runners are not
 * affected.
 */
async function checkMonthlyKillSwitch(): Promise<void> {
  const env = getEnv();
  const raw = env.SDLC_MONTHLY_KILL_SWITCH_USD;
  if (!raw) {
    log.info('Monthly kill switch unset; skipping budget check');
    return;
  }
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap <= 0) {
    log.warn('SDLC_MONTHLY_KILL_SWITCH_USD set but not a positive number; ignoring', { raw });
    return;
  }
  const cost = await getMonthlyAgentCost();
  log.info('Monthly kill switch check', {
    capUsd: cap,
    totalCostUsd: cost.totalCostUsd,
    rowCount: cost.rowCount,
    startedAtSince: cost.startedAtSince,
  });
  if (cost.totalCostUsd < cap) return;

  const { writeFile } = await import('node:fs/promises');
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace) {
    const markerPath = path.join(workspace, '.budget-kill-switch-tripped');
    const payload = {
      capUsd: cap,
      totalCostUsd: cost.totalCostUsd,
      rowCount: cost.rowCount,
      startedAtSince: cost.startedAtSince,
      refusedAt: new Date().toISOString(),
    };
    await writeFile(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    log.error('Monthly kill switch tripped; refusing to start new run', payload);
  } else {
    log.error('Monthly kill switch tripped (no workspace to write marker)', {
      capUsd: cap,
      totalCostUsd: cost.totalCostUsd,
    });
  }
  process.exit(2);
}

main().catch((err) => {
  log.error('Orchestrator crashed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
