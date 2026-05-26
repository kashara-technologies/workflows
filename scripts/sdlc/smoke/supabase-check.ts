// Verifies that the Supabase project the orchestrator is configured to use
// actually has the agent_runs table and the agent-payloads storage bucket
// from Phase A. Intended to run from a workflow_dispatch step so the real
// org secrets are available; not invoked by the pipeline.

import { getSupabase } from '../lib/supabase.js';
import { log } from '../lib/logger.js';

const EXPECTED_COLUMNS: readonly string[] = [
  'id',
  'pipeline_run_id',
  'feature_path',
  'product',
  'agent',
  'retry_count',
  'model',
  'started_at',
  'finished_at',
  'status',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cost_usd',
  'prompt_hash',
  'input_payload_path',
  'output_payload_path',
  'error_message',
  'created_at',
];

const REQUIRED_BUCKET = 'agent-payloads';

async function checkAgentRunsTable(): Promise<void> {
  const sb = getSupabase();
  // Select all design columns; non-existent columns surface as a useful error.
  const { data, error } = await sb
    .from('agent_runs')
    .select(EXPECTED_COLUMNS.join(','))
    .limit(1);
  if (error) {
    throw new Error(`agent_runs probe failed: ${error.message}`);
  }
  log.info('agent_runs table is queryable', {
    rowsReturned: data?.length ?? 0,
    columnsProbed: EXPECTED_COLUMNS.length,
  });
}

async function checkAgentPayloadsBucket(): Promise<void> {
  const sb = getSupabase();
  const { data, error } = await sb.storage.listBuckets();
  if (error) {
    throw new Error(`listBuckets failed: ${error.message}`);
  }
  const names = (data ?? []).map((b) => b.name);
  if (!names.includes(REQUIRED_BUCKET)) {
    throw new Error(
      `bucket "${REQUIRED_BUCKET}" not found. Existing buckets: ${names.join(', ') || '(none)'}`,
    );
  }
  log.info('agent-payloads bucket exists', { buckets: names });
}

async function main(): Promise<void> {
  log.info('Supabase smoke check starting');
  await checkAgentRunsTable();
  await checkAgentPayloadsBucket();
  log.info('Supabase smoke check passed');
}

main().catch((err) => {
  log.error('Supabase smoke check failed', {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
