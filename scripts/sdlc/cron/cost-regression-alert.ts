// Nightly cost regression cron.
//
// Per docs/handoffs/phase-g-handoff.md section 1:
//   * Query the most recent pipeline_run cost from Supabase.
//   * Assert it falls within the $0.40 / $8.00 envelope.
//   * Alert via Slack #alerts-warning if out of bounds. Does NOT block PRs.
//
// Drops .cost-regression-alert.json into $GITHUB_WORKSPACE when the most
// recent run is out of envelope; the workflow downstream routes Slack from
// the marker. Always exits 0 so the cron itself never pages.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeCostRegression } from '../lib/cost-regression.js';
import { log } from '../lib/logger.js';

async function main(): Promise<void> {
  const report = await computeCostRegression();
  log.info('Cost regression summary', {
    config: report.config,
    recencySinceIso: report.recencySinceIso,
    mostRecent: report.mostRecent,
    outOfEnvelope: report.outOfEnvelope,
    reasons: report.reasons,
  });

  if (!report.mostRecent) {
    log.info('No recent pipeline run found in window; nothing to check');
    return;
  }

  if (!report.outOfEnvelope) {
    log.info('Most recent pipeline run is inside envelope; no marker written');
    return;
  }

  log.warn('Most recent pipeline run is out of envelope', {
    mostRecent: report.mostRecent,
    reasons: report.reasons,
  });

  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    log.warn('Out-of-envelope detected but GITHUB_WORKSPACE unset; cannot write marker');
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
