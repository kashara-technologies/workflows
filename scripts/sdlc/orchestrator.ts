// Kashara SDLC orchestrator entry point.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCoder } from './agents/coder.js';
import { runPlanner } from './agents/planner.js';
import { runTester } from './agents/tester.js';
import { OPUS_MODEL_ID } from './lib/anthropic.js';
import { createAuditLogger } from './lib/audit.js';
import { getEnv } from './lib/env.js';
import { commitAndPushBuildBranch, prepareBuildBranch } from './lib/git.js';
import { assertCanWriteToRepo } from './lib/github-app.js';
import {
  findOrCreateBuildPr,
  markPrReadyForReview,
  postPrComment,
  setBuildLabel,
} from './lib/github-pr.js';
import { log } from './lib/logger.js';
import { coderRetryComment, finalComment, milestoneComment } from './lib/pr-comments.js';
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

  // Fail fast if the App can't push the artifacts, before burning Anthropic
  // credit on the agents.
  await assertCanWriteToRepo(env.GITHUB_REPOSITORY);

  // Set up the build branch fresh from main. Every artifact and code file the
  // agents produce lands on top of this branch.
  await prepareBuildBranch({ repoPath: ctx.repoPath, branch: ctx.buildBranch });

  const audit = createAuditLogger(ctx.artifactsPath);
  const artifactsRelDir = path.relative(ctx.repoPath, ctx.artifactsPath);

  // Push an initial empty commit so the build branch exists on the remote and
  // we can open a PR against it. Without this, findOrCreateBuildPr would fail
  // with "head ref does not exist".
  await commitAndPushBuildBranch({
    repoPath: ctx.repoPath,
    branch: ctx.buildBranch,
    message: `chore(build): initialize ${ctx.feature} pipeline run ${ctx.pipelineRunId.slice(0, 8)}`,
  });

  const buildPr = await findOrCreateBuildPr({
    branch: ctx.buildBranch,
    baseBranch: 'main',
    feature: ctx.feature,
    initialBody:
      `# Build PR for \`${ctx.feature}\`\n\n` +
      `This PR is managed by the Kashara SDLC orchestrator. It is force-pushed on every PRD update.\n\n` +
      `Pipeline run \`${ctx.pipelineRunId}\` in progress.`,
  });
  await setBuildLabel({ prNumber: buildPr.number, label: 'build:planning' });

  let pipelineSucceeded = false;
  let finalDecision: 'pass' | 'fail' | 'unknown' = 'unknown';
  let totalCostUsd = 0;
  let totalTurns = 0;
  let retriesUsed = 0;

  try {
    // --- Planner ---
    const planner = await runPlanner(ctx);
    totalCostUsd += planner.agentResult.costUsd;
    totalTurns += planner.agentResult.turns;
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
      totalCostUsd += coder.agentResult.costUsd;
      totalTurns += coder.agentResult.turns;
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
        pipelineSucceeded = true;
        finalDecision = 'pass';
        // Phase E reviewer will eventually run here; for Phase D we leave the
        // PR in build:reviewing as the terminal state of a green pipeline.
        await setBuildLabel({ prNumber: buildPr.number, label: 'build:reviewing' });
        break;
      }
      if (tester.decision === 'UNKNOWN') {
        log.warn('Tester decision unparseable; treating as FAIL for retry purposes', {
          attempt,
        });
      }
      if (attempt === MAX_CODER_RETRIES) {
        finalDecision = 'fail';
        log.warn('Tester FAIL on final attempt; pipeline ends with failure', { attempt });
        await setBuildLabel({ prNumber: buildPr.number, label: 'build:failed' });
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
  } catch (err) {
    log.error('Pipeline stage threw', { error: (err as Error).message, stack: (err as Error).stack });
    try {
      await setBuildLabel({ prNumber: buildPr.number, label: 'build:failed' });
    } catch {
      // best effort; don't mask the original error
    }
    throw err;
  } finally {
    // Commit and push whatever the agents wrote, even on partial failure.
    const message =
      `chore(build): ${finalDecision === 'pass' ? 'planner+coder+tester pass' : 'pipeline run, decision=' + finalDecision} for ${ctx.feature}\n\n` +
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
      finalDecision,
    });

    try {
      await postPrComment({
        prNumber: buildPr.number,
        body: finalComment({
          decision: finalDecision === 'pass' ? 'pass' : 'fail',
          feature: ctx.feature,
          repo: env.GITHUB_REPOSITORY,
          branch: ctx.buildBranch,
          artifactDir: artifactsRelDir,
          commitSha: pushResult.commitSha,
          totalCostUsd,
          totalTurns,
          retriesUsed,
        }),
      });
    } catch (err) {
      log.warn('Failed to post final PR comment', { error: (err as Error).message });
    }

    if (finalDecision === 'pass') {
      try {
        await markPrReadyForReview(buildPr.number);
      } catch (err) {
        log.warn('Failed to mark PR ready for review', { error: (err as Error).message });
      }
    }
  }

  log.info('Phase D pipeline complete.', {
    pipelineRunId: ctx.pipelineRunId,
    succeeded: pipelineSucceeded,
    finalDecision,
    totalCostUsd,
    totalTurns,
    retriesUsed,
  });

  if (!pipelineSucceeded) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error('Orchestrator crashed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
