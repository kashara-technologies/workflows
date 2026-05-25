// Kashara SDLC orchestrator entry point.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCoder } from './agents/coder.js';
import { runPlanner } from './agents/planner.js';
import { runTester } from './agents/tester.js';
import { createAuditLogger } from './lib/audit.js';
import { getEnv } from './lib/env.js';
import { commitAndPushBuildBranch, prepareBuildBranch } from './lib/git.js';
import { assertCanWriteToRepo } from './lib/github-app.js';
import { log } from './lib/logger.js';
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

  let pipelineSucceeded = false;
  let finalDecision: 'pass' | 'fail' | 'unknown' = 'unknown';
  try {
    // --- Planner ---
    const planner = await runPlanner(ctx);
    log.info('Planner stage complete', {
      planPath: planner.planPath,
      turns: planner.agentResult.turns,
      costUsd: planner.agentResult.costUsd,
    });

    const planRelPath = path.relative(ctx.repoPath, planner.planPath);

    // --- Coder + Tester retry loop ---
    let lastTestResultsRelPath: string | undefined;
    let summaryRelPath = '';

    for (let attempt = 0; attempt <= MAX_CODER_RETRIES; attempt++) {
      // Coder.
      const coder = await runCoder({
        ctx,
        audit,
        planRelPath,
        previousTestResultsRelPath: lastTestResultsRelPath,
        retryCount: attempt,
      });
      summaryRelPath = path.relative(ctx.repoPath, coder.summaryPath);
      log.info('Coder stage complete', {
        attempt,
        summaryPath: coder.summaryPath,
        turns: coder.agentResult.turns,
        costUsd: coder.agentResult.costUsd,
      });

      // Tester.
      const tester = await runTester({
        ctx,
        audit,
        planRelPath,
        summaryRelPath,
      });
      lastTestResultsRelPath = path.relative(ctx.repoPath, tester.testResultsPath);
      log.info('Tester stage complete', {
        attempt,
        testResultsPath: tester.testResultsPath,
        decision: tester.decision,
        turns: tester.agentResult.turns,
        costUsd: tester.agentResult.costUsd,
      });

      if (tester.decision === 'PASS') {
        pipelineSucceeded = true;
        finalDecision = 'pass';
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
        break;
      }
      log.info('Tester FAIL; entering coder retry', { nextAttempt: attempt + 1 });
    }
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
  }

  log.info('Phase D pipeline complete.', {
    pipelineRunId: ctx.pipelineRunId,
    succeeded: pipelineSucceeded,
    finalDecision,
  });

  if (!pipelineSucceeded) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error('Orchestrator crashed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
