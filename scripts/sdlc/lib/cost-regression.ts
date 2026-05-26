// Cost-per-pipeline-run regression detector.
//
// Built on top of F3's monthly aggregation. The monthly budget cron asks
// "are we burning the credit?". This asks "is a single pipeline run
// suddenly costing twice what it used to?" — the early warning for prompt
// regressions, model price changes, or a runaway retry loop that isn't yet
// hitting the kill switch.
//
// Approach:
//   1. Pull cost_usd for every successful agent_run in the trailing 7-day
//      window. Group by pipeline_run_id, sum to get the per-pipeline cost.
//   2. Compute median over that window. Anything in the most recent 24
//      hours is a "fresh" run.
//   3. A fresh run is out-of-envelope if it exceeds an absolute cap (default
//      $30) OR exceeds (relative multiplier × median, default 1.5×) AND a
//      floor (default $10) to avoid alerting on noise when the median is
//      tiny because the window is still warming up.

import { log } from './logger.js';
import { getSupabase } from './supabase.js';

export const DEFAULT_ABSOLUTE_CAP_USD = 30;
export const DEFAULT_RELATIVE_MULTIPLIER = 1.5;
export const DEFAULT_FLOOR_USD = 10;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_FRESH_HOURS = 24;

export interface PipelineRunCost {
  pipelineRunId: string;
  costUsd: number;
  firstStartedAt: string;
  agentRunCount: number;
}

export interface CostRegressionConfig {
  absoluteCapUsd: number;
  relativeMultiplier: number;
  floorUsd: number;
  windowDays: number;
  freshHours: number;
}

export interface CostRegressionReport {
  config: CostRegressionConfig;
  windowStartIso: string;
  freshSinceIso: string;
  baselineMedianUsd: number | null;
  pipelineRunsInWindow: number;
  freshRuns: PipelineRunCost[];
  outOfEnvelope: OutOfEnvelopeRun[];
}

export interface OutOfEnvelopeRun extends PipelineRunCost {
  reasons: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function defaultConfig(): CostRegressionConfig {
  return {
    absoluteCapUsd: parseNumberFromEnv('COST_REGRESSION_ABSOLUTE_CAP_USD', DEFAULT_ABSOLUTE_CAP_USD),
    relativeMultiplier: parseNumberFromEnv('COST_REGRESSION_RELATIVE_MULTIPLIER', DEFAULT_RELATIVE_MULTIPLIER),
    floorUsd: parseNumberFromEnv('COST_REGRESSION_FLOOR_USD', DEFAULT_FLOOR_USD),
    windowDays: parseNumberFromEnv('COST_REGRESSION_WINDOW_DAYS', DEFAULT_WINDOW_DAYS),
    freshHours: parseNumberFromEnv('COST_REGRESSION_FRESH_HOURS', DEFAULT_FRESH_HOURS),
  };
}

function parseNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Group rows by pipeline_run_id, summing cost_usd and capturing the earliest
 * started_at. Used by both detection and report generation.
 */
function groupRows(
  rows: Array<{ pipeline_run_id: string; cost_usd: unknown; started_at: string }>,
): PipelineRunCost[] {
  const acc = new Map<string, PipelineRunCost>();
  for (const row of rows) {
    const cost = coerceCost(row.cost_usd);
    const existing = acc.get(row.pipeline_run_id);
    if (existing) {
      existing.costUsd += cost;
      existing.agentRunCount += 1;
      if (row.started_at < existing.firstStartedAt) {
        existing.firstStartedAt = row.started_at;
      }
    } else {
      acc.set(row.pipeline_run_id, {
        pipelineRunId: row.pipeline_run_id,
        costUsd: cost,
        firstStartedAt: row.started_at,
        agentRunCount: 1,
      });
    }
  }
  return [...acc.values()].map((p) => ({ ...p, costUsd: Number(p.costUsd.toFixed(4)) }));
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
  const windowStart = new Date(now.getTime() - config.windowDays * 24 * 60 * 60 * 1000);
  const freshSince = new Date(now.getTime() - config.freshHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const freshSinceIso = freshSince.toISOString();

  const sb = getSupabase();
  const { data, error } = await sb
    .from('agent_runs')
    .select('pipeline_run_id, cost_usd, started_at')
    .gte('started_at', windowStartIso)
    .eq('status', 'success')
    .limit(20_000);
  if (error) {
    log.warn('cost-regression query failed', { error: error.message });
    return {
      config,
      windowStartIso,
      freshSinceIso,
      baselineMedianUsd: null,
      pipelineRunsInWindow: 0,
      freshRuns: [],
      outOfEnvelope: [],
    };
  }

  const grouped = groupRows(
    (data ?? []) as Array<{ pipeline_run_id: string; cost_usd: unknown; started_at: string }>,
  );
  const baselineMedianUsd = median(grouped.map((g) => g.costUsd));
  const freshRuns = grouped.filter((g) => g.firstStartedAt >= freshSinceIso);
  const outOfEnvelope: OutOfEnvelopeRun[] = [];
  for (const r of freshRuns) {
    const reasons: string[] = [];
    if (r.costUsd >= config.absoluteCapUsd) {
      reasons.push(`absolute cap exceeded ($${r.costUsd.toFixed(2)} >= $${config.absoluteCapUsd})`);
    }
    if (
      baselineMedianUsd != null &&
      r.costUsd >= config.floorUsd &&
      r.costUsd >= config.relativeMultiplier * baselineMedianUsd
    ) {
      reasons.push(
        `relative regression ($${r.costUsd.toFixed(2)} >= ${config.relativeMultiplier}x median $${baselineMedianUsd.toFixed(2)})`,
      );
    }
    if (reasons.length > 0) outOfEnvelope.push({ ...r, reasons });
  }

  return {
    config,
    windowStartIso,
    freshSinceIso,
    baselineMedianUsd: baselineMedianUsd != null ? Number(baselineMedianUsd.toFixed(4)) : null,
    pipelineRunsInWindow: grouped.length,
    freshRuns,
    outOfEnvelope,
  };
}
