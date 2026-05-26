// Nightly cost regression cron.
//
// Reads agent_runs over the trailing window, groups by pipeline_run_id,
// detects out-of-envelope fresh runs, and drops .cost-regression-alert.json
// into $GITHUB_WORKSPACE when at least one fires. Exit 0 always; the alert
// is the signal.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeCostRegression } from '../lib/cost-regression.js';
import { log } from '../lib/logger.js';

async function main(): Promise<void> {
  const report = await computeCostRegression();
  log.info('Cost regression summary', {
    config: report.config,
    windowStartIso: report.windowStartIso,
    freshSinceIso: report.freshSinceIso,
    pipelineRunsInWindow: report.pipelineRunsInWindow,
    freshRuns: report.freshRuns.length,
    baselineMedianUsd: report.baselineMedianUsd,
    outOfEnvelope: report.outOfEnvelope.length,
  });

  for (const flagged of report.outOfEnvelope) {
    log.warn('Out-of-envelope pipeline run', flagged as unknown as Record<string, unknown>);
  }

  if (report.outOfEnvelope.length === 0) {
    log.info('All fresh runs inside envelope; no marker written');
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    log.warn('Out-of-envelope runs detected but GITHUB_WORKSPACE unset; cannot write marker');
    return;
  }
  const markerPath = path.join(workspace, '.cost-regression-alert.json');
  await writeFile(markerPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  log.info('Wrote cost-regression-alert marker; Slack warning will fire', { markerPath });
}

main().catch((err) => {
  log.error('Cost regression cron failed', {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(0);
});
