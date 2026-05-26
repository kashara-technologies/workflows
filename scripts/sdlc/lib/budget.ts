// Monthly Anthropic spend, self-tracked from agent_runs.cost_usd.
//
// The Anthropic admin API would also surface this, but reading from our own
// agent_runs avoids adding a new credential and means the budget signal is
// consistent with whatever the orchestrator just billed.

import { log } from './logger.js';
import { getSupabase } from './supabase.js';

/** $200 Agent SDK credit per docs/sdlc-pipeline-design.md section 9. */
export const MONTHLY_BUDGET_USD = 200;

/** 80% of the monthly cap. Soft alert threshold for the nightly cron. */
export const SOFT_ALERT_THRESHOLD_USD = MONTHLY_BUDGET_USD * 0.8;

/** ISO timestamp of the first instant of the current calendar month, UTC. */
export function startOfCurrentMonthUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return d.toISOString();
}

export interface MonthlyCost {
  startedAtSince: string;
  totalCostUsd: number;
  rowCount: number;
}

/**
 * Sum cost_usd from agent_runs over the current calendar month UTC. Returns
 * 0 / 0 rows when the table is empty or unreachable; the caller decides
 * whether to treat that as a hard fault.
 */
export async function getMonthlyAgentCost(now: Date = new Date()): Promise<MonthlyCost> {
  const since = startOfCurrentMonthUtc(now);
  const sb = getSupabase();
  // Pull cost_usd for every row in the window. Could be many; cap defensively.
  const { data, error } = await sb
    .from('agent_runs')
    .select('cost_usd')
    .gte('started_at', since)
    .limit(50_000);
  if (error) {
    log.warn('agent_runs cost query failed', { error: error.message });
    return { startedAtSince: since, totalCostUsd: 0, rowCount: 0 };
  }
  let total = 0;
  for (const row of data ?? []) {
    const v = row.cost_usd;
    if (typeof v === 'number') total += v;
    else if (typeof v === 'string' && v.trim() !== '') {
      // numeric(10,4) sometimes serializes as string; parse defensively.
      const parsed = Number(v);
      if (!Number.isNaN(parsed)) total += parsed;
    }
  }
  return {
    startedAtSince: since,
    totalCostUsd: Number(total.toFixed(4)),
    rowCount: data?.length ?? 0,
  };
}
