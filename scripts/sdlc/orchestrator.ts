// Kashara SDLC orchestrator entry point.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { runPlanner } from './agents/planner.js';
import { getEnv } from './lib/env.js';
import { commitAndPushArtifacts } from './lib/git.js';
import { assertCanWriteToRepo } from './lib/github-app.js';
import { log } from './lib/logger.js';
import { buildRunContext, parsePrdPath } from './lib/run-context.js';
import { getSupabase } from './lib/supabase.js';

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

  // Fail fast if the App can't push the artifact, before spending Anthropic
  // credit on the planner.
  await assertCanWriteToRepo(env.GITHUB_REPOSITORY);

  const planner = await runPlanner(ctx);
  log.info('Planner stage complete', {
    planPath: planner.planPath,
    turns: planner.agentResult.turns,
    costUsd: planner.agentResult.costUsd,
    inputTokens: planner.agentResult.usage.inputTokens,
    outputTokens: planner.agentResult.usage.outputTokens,
  });

  // Push the artifact to the build branch on the product repo.
  const relPlanPath = path.relative(ctx.repoPath, planner.planPath);
  const { commitSha, branch } = await commitAndPushArtifacts({
    repoPath: ctx.repoPath,
    branch: ctx.buildBranch,
    paths: [relPlanPath],
    message: `chore(build): planner output for ${ctx.feature}\n\nPipeline run ${ctx.pipelineRunId}.`,
  });
  log.info('Artifact pushed', { branch, commitSha, relPlanPath });

  log.info('Phase C planner stage complete. Exiting cleanly.', {
    pipelineRunId: ctx.pipelineRunId,
  });
}

main().catch((err) => {
  log.error('Orchestrator crashed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
