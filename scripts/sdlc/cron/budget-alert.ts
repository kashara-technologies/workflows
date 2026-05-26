// Nightly Anthropic budget cron.
//
// Sums cost_usd from agent_runs over the current calendar month. If the total
// is over the soft alert threshold (80% of the $200 cap), drops
// `.budget-alert.json` into $GITHUB_WORKSPACE so the workflow can route a
// Slack warning. Always exits 0 so the cron job itself never pages; the
// alert is the signal.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MONTHLY_BUDGET_USD,
  SOFT_ALERT_THRESHOLD_USD,
  getMonthlyAgentCost,
} from '../lib/budget.js';
import { log } from '../lib/logger.js';

async function main(): Promise<void> {
  log.info('Budget cron starting', {
    budgetUsd: MONTHLY_BUDGET_USD,
    softAlertThresholdUsd: SOFT_ALERT_THRESHOLD_USD,
  });
  const result = await getMonthlyAgentCost();
  const percentOfBudget = (result.totalCostUsd / MONTHLY_BUDGET_USD) * 100;
  log.info('Monthly spend summary', {
    startedAtSince: result.startedAtSince,
    rowCount: result.rowCount,
    totalCostUsd: result.totalCostUsd,
    percentOfBudget: Number(percentOfBudget.toFixed(1)),
  });
  if (result.totalCostUsd >= SOFT_ALERT_THRESHOLD_USD) {
    const workspace = process.env.GITHUB_WORKSPACE;
    if (workspace) {
      const markerPath = path.join(workspace, '.budget-alert.json');
      const payload = {
        startedAtSince: result.startedAtSince,
        totalCostUsd: result.totalCostUsd,
        budgetUsd: MONTHLY_BUDGET_USD,
        softAlertThresholdUsd: SOFT_ALERT_THRESHOLD_USD,
        percentOfBudget: Number(percentOfBudget.toFixed(1)),
        rowCount: result.rowCount,
      };
      await writeFile(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      log.info('Wrote budget-alert marker; Slack warning will fire', { markerPath });
    } else {
      log.warn('Over soft threshold but GITHUB_WORKSPACE unset; cannot write marker');
    }
  } else {
    log.info('Spend below soft alert threshold; no marker written');
  }
}

main().catch((err) => {
  log.error('Budget cron failed', {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  // Exit 0 so the cron run is green even if Supabase is briefly down; the
  // next run picks it up. Surface as a Slack alert only when we know the
  // spend.
  process.exit(0);
});
