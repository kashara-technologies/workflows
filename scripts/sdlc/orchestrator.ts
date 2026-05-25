// Kashara SDLC orchestrator entry point.
//
// Phase B (current): boots, validates env, parses inputs, exits cleanly.
// Phase C+ will add agent invocation.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { getEnv } from './lib/env.js';
import { log } from './lib/logger.js';
import { buildRunContext, parsePrdPath } from './lib/run-context.js';
import { getSupabase } from './lib/supabase.js';

async function main(): Promise<void> {
  log.info('Kashara SDLC orchestrator starting');

  // 1. Validate env vars; fail loud and early.
  const env = getEnv();
  log.info('Env validated', {
    repo: env.GITHUB_REPOSITORY,
    workspace: env.GITHUB_WORKSPACE,
  });

  // 2. Resolve which PRD triggered this run.
  // For now, accept it as an arg or environment variable.
  // Phase B+ will detect the changed PRD from the push event.
  const prdPath = process.argv[2] ?? process.env.PRD_PATH;
  if (!prdPath) {
    log.error('No PRD path provided. Pass as first arg or PRD_PATH env var.');
    process.exit(1);
  }
  log.info('PRD path', { prdPath });

  // 3. Validate the PRD path matches the expected pattern.
  const { product, feature } = parsePrdPath(prdPath);
  log.info('Parsed PRD', { product, feature });

  // 4. Confirm the PRD file actually exists.
  const absolutePrdPath = path.join(env.GITHUB_WORKSPACE, prdPath);
  if (!existsSync(absolutePrdPath)) {
    log.error('PRD file not found on disk', { absolutePrdPath });
    process.exit(1);
  }

  // 5. Build the run context.
  const ctx = buildRunContext(prdPath);
  log.info('Run context built', {
    pipelineRunId: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
    buildBranch: ctx.buildBranch,
  });

  // 6. Smoke test the Supabase connection (read-only).
  // We just check we can construct the client without it throwing.
  // Real DB writes come in Phase F.
  try {
    const sb = getSupabase();
    const { error } = await sb.from('agent_runs').select('id').limit(1);
    if (error) {
      log.warn('Supabase connection works but query returned error', { error: error.message });
    } else {
      log.info('Supabase connection verified');
    }
  } catch (err) {
    log.error('Supabase connection failed', { error: (err as Error).message });
    process.exit(1);
  }

  // 7. End of Phase B work.
  // Phase C will: load planner prompt, call Anthropic API, write 01-plan.md.
  log.info('Phase B skeleton complete. Exiting cleanly.', {
    pipelineRunId: ctx.pipelineRunId,
    note: 'No agents invoked yet. See docs/sdlc-pipeline-design.md for roadmap.',
  });
}

main().catch((err) => {
  log.error('Orchestrator crashed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
