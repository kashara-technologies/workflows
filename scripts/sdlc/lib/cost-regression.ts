// Per-pipeline cost envelope check.
//
// Spec from docs/handoffs/phase-g-handoff.md section 1:
//   * Baseline envelope: $0.40 min, $8.00 max per pipeline run including
//     retries.
//   * Query the most recent pipeline_run cost from Supabase.
//   * Assert it falls within the envelope.
//   * Alert via Slack #alerts-warning if out of bounds. Does NOT block PR
//     merges; the signal is the alert.
//
// Implementation note: F2 emits pipeline_run_completed to PostHog, but the
// canonical durable record is the F1 agent_runs table in Supabase. So
// "pipeline_run cost" here = sum(cost_usd) over agent_runs rows sharing the
// most recent pipeline_run_id (within a recency window so we don't pick up
// a stale never-finished run).

import { log } from './logger.js';
import { getSupabase } from './supabase.js';

export const DEFAULT_MIN_USD = 0.4;
// Raised from 8.0 after the first production auth run came in at $12 (one
// retry) and $20 (blocked-review path). Median per-feature run is closer to
// $12 to $14; $15 catches 2x-spike regressions without alerting on every
// normal feature build.
export const DEFAULT_MAX_USD = 15.0;
export const DEFAULT_PRODUCT = 'pulse';
/** Look back this many hours when picking the "most recent" pipeline run. */
export const DEFAULT_RECENCY_HOURS = 48;

export interface CostRegressionConfig {
  minUsd: number;
  maxUsd: number;
  product: string;
  recencyHours: number;
}

export interface MostRecentPipelineRun {
  pipelineRunId: string;
  product: string;
  totalCostUsd: number;
  latestStartedAt: string;
  agentRunCount: number;
}

export interface CostRegressionReport {
  config: CostRegressionConfig;
  recencySinceIso: string;
  /** Null when no pipeline run was found in the recency window. */
  mostRecent: MostRecentPipelineRun | null;
  outOfEnvelope: boolean;
  reasons: string[];
}

function parseNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStringFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? raw : fallback;
}

export function defaultConfig(): CostRegressionConfig {
  return {
    minUsd: parseNumberFromEnv('COST_REGRESSION_MIN_USD', DEFAULT_MIN_USD),
    maxUsd: parseNumberFromEnv('COST_REGRESSION_MAX_USD', DEFAULT_MAX_USD),
    product: parseStringFromEnv('COST_REGRESSION_PRODUCT', DEFAULT_PRODUCT),
    recencyHours: parseNumberFromEnv('COST_REGRESSION_RECENCY_HOURS', DEFAULT_RECENCY_HOURS),
  };
}

function coerceCost(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

export async function computeCostRegression(
  now: Date = new Date(),
  config: CostRegressionConfig = defaultConfig(),
): Promise<CostRegressionReport> {
  const recencySince = new Date(now.getTime() - config.recencyHours * 60 * 60 * 1000);
  const recencySinceIso = recencySince.toISOString();

  const sb = getSupabase();
  const { data, error } = await sb
    .from('agent_runs')
    .select('pipeline_run_id, cost_usd, started_at, product')
    .gte('started_at', recencySinceIso)
    .eq('product', config.product)
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(500);
  if (error) {
    log.warn('cost-regression query failed', { error: error.message });
    return {
      config,
      recencySinceIso,
      mostRecent: null,
      outOfEnvelope: false,
      reasons: [`query failed: ${error.message}`],
    };
  }

  if (!data || data.length === 0) {
    return {
      config,
      recencySinceIso,
      mostRecent: null,
      outOfEnvelope: false,
      reasons: [],
    };
  }

  // First row has the latest started_at. Its pipeline_run_id is the most
  // recent run. Sum cost_usd across every row that shares that id.
  const latestRow = data[0]!;
  const targetRunId = latestRow.pipeline_run_id as string;
  let totalCostUsd = 0;
  let agentRunCount = 0;
  let latestStartedAt = '';
  for (const row of data) {
    if (row.pipeline_run_id !== targetRunId) continue;
    totalCostUsd += coerceCost(row.cost_usd);
    agentRunCount += 1;
    if (row.started_at > latestStartedAt) latestStartedAt = row.started_at as string;
  }
  totalCostUsd = Number(totalCostUsd.toFixed(4));

  const reasons: string[] = [];
  if (totalCostUsd < config.minUsd) {
    reasons.push(
      `total cost $${totalCostUsd.toFixed(2)} is below envelope minimum $${config.minUsd.toFixed(2)}`,
    );
  }
  if (totalCostUsd > config.maxUsd) {
    reasons.push(
      `total cost $${totalCostUsd.toFixed(2)} is above envelope maximum $${config.maxUsd.toFixed(2)}`,
    );
  }

  return {
    config,
    recencySinceIso,
    mostRecent: {
      pipelineRunId: targetRunId,
      product: config.product,
      totalCostUsd,
      latestStartedAt,
      agentRunCount,
    },
    outOfEnvelope: reasons.length > 0,
    reasons,
  };
}
