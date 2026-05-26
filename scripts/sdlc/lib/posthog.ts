// PostHog event emission for SDLC observability.
//
// Two event shapes per docs/sdlc-pipeline-design.md section 7:
//   * agent_run_completed: one per agent invocation (planner / coder / tester
//     / reviewer; coder retries each get their own event).
//   * pipeline_run_completed: one per pipeline run, in the orchestrator's
//     finally block, with the terminal outcome.
//
// Telemetry is opt-in. If POSTHOG_KEY or POSTHOG_HOST is unset, every
// helper here is a no-op. Failures are warn-and-continue; the pipeline
// never blocks on PostHog.

import { PostHog } from 'posthog-node';
import { getEnv } from './env.js';
import { log } from './logger.js';
import type { AgentName } from '../types.js';

let _client: PostHog | null = null;
let _checked = false;

function getClient(): PostHog | null {
  if (_checked) return _client;
  _checked = true;
  const env = getEnv();
  if (!env.POSTHOG_KEY || !env.POSTHOG_HOST) {
    log.info('PostHog credentials not set; telemetry disabled');
    return null;
  }
  _client = new PostHog(env.POSTHOG_KEY, {
    host: env.POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
  log.info('PostHog client initialized', { host: env.POSTHOG_HOST });
  return _client;
}

export interface AgentRunCompletedEvent {
  pipelineRunId: string;
  agent: AgentName;
  product: string;
  feature: string;
  model: string;
  status: 'success' | 'failure' | 'timeout';
  durationMs: number;
  costUsd: number | null;
  retryCount: number;
}

export function emitAgentRunCompleted(event: AgentRunCompletedEvent): void {
  const client = getClient();
  if (!client) return;
  try {
    client.capture({
      distinctId: event.pipelineRunId,
      event: 'agent_run_completed',
      properties: {
        pipeline_run_id: event.pipelineRunId,
        agent: event.agent,
        product: event.product,
        feature: event.feature,
        model: event.model,
        status: event.status,
        duration_ms: event.durationMs,
        cost_usd: event.costUsd,
        retry_count: event.retryCount,
      },
    });
  } catch (err) {
    log.warn('PostHog capture failed', {
      event: 'agent_run_completed',
      error: (err as Error).message,
    });
  }
}

export interface PipelineRunCompletedEvent {
  pipelineRunId: string;
  product: string;
  feature: string;
  outcome: 'approved' | 'blocked' | 'failed';
  totalCostUsd: number;
  totalDurationMs: number;
  agentCount: number;
  retriesUsed: number;
}

export function emitPipelineRunCompleted(event: PipelineRunCompletedEvent): void {
  const client = getClient();
  if (!client) return;
  try {
    client.capture({
      distinctId: event.pipelineRunId,
      event: 'pipeline_run_completed',
      properties: {
        pipeline_run_id: event.pipelineRunId,
        product: event.product,
        feature: event.feature,
        outcome: event.outcome,
        total_cost_usd: event.totalCostUsd,
        total_duration_ms: event.totalDurationMs,
        agent_count: event.agentCount,
        retries_used: event.retriesUsed,
      },
    });
  } catch (err) {
    log.warn('PostHog capture failed', {
      event: 'pipeline_run_completed',
      error: (err as Error).message,
    });
  }
}

/**
 * Flush + shutdown. Call once at orchestrator exit so in-flight events are
 * delivered before the runner terminates the process.
 */
export async function shutdownPostHog(): Promise<void> {
  const client = _client;
  if (!client) return;
  try {
    await client.shutdown();
    log.info('PostHog client shut down cleanly');
  } catch (err) {
    log.warn('PostHog shutdown failed', { error: (err as Error).message });
  }
}
