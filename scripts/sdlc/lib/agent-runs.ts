// Writer for the `agent_runs` table provisioned in Phase A.
//
// One row per agent invocation, inserted after the agent finishes (success,
// failure, or timeout). The orchestrator already keeps the planner / coder
// / tester / reviewer audit in the build branch via the 99-audit.log + the
// per-agent Markdown artifacts; this table is the durable, queryable copy
// used for dashboards and cost roll-ups.

import { log } from './logger.js';
import { getSupabase } from './supabase.js';
import type { AgentName, RunStatus } from '../types.js';

export interface AgentRunRow {
  pipelineRunId: string;
  featurePath: string;
  product: string;
  agent: AgentName;
  retryCount: number;
  model: string;
  startedAt: string;
  finishedAt: string;
  status: Exclude<RunStatus, 'blocked'>;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  promptHash: string | null;
  inputPayloadPath: string | null;
  outputPayloadPath: string | null;
  errorMessage: string | null;
}

export async function insertAgentRun(row: AgentRunRow): Promise<{ id: string } | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('agent_runs')
    .insert({
      pipeline_run_id: row.pipelineRunId,
      feature_path: row.featurePath,
      product: row.product,
      agent: row.agent,
      retry_count: row.retryCount,
      model: row.model,
      started_at: row.startedAt,
      finished_at: row.finishedAt,
      status: row.status,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cached_input_tokens: row.cachedInputTokens,
      cost_usd: row.costUsd,
      prompt_hash: row.promptHash,
      input_payload_path: row.inputPayloadPath,
      output_payload_path: row.outputPayloadPath,
      error_message: row.errorMessage,
    })
    .select('id')
    .single();
  if (error) {
    log.warn('Failed to insert agent_runs row', {
      agent: row.agent,
      pipelineRunId: row.pipelineRunId,
      error: error.message,
    });
    return null;
  }
  log.info('Inserted agent_runs row', {
    id: data?.id,
    agent: row.agent,
    status: row.status,
    pipelineRunId: row.pipelineRunId,
  });
  return data?.id ? { id: data.id as string } : null;
}
