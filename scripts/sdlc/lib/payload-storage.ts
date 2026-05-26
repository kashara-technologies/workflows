// Upload agent input/output payloads to the agent-payloads Supabase Storage
// bucket provisioned in Phase A.
//
// Path layout: <YYYY-MM-DD>/<pipeline_run_id>/<agent>-<retry>-<kind>.json
//   YYYY-MM-DD partitions by day for easy lifecycle policies later.
//   pipeline_run_id groups every artifact from one pipeline run.
//   retry distinguishes attempt 0 from coder retries.
//   kind is "input" or "output".
//
// The full input payload (system + user blocks + tool definitions) and the
// full output payload (final text + accumulated usage + turn count) are
// stored verbatim so any agent run can be replayed.

import { log } from './logger.js';
import { getSupabase } from './supabase.js';

export const PAYLOADS_BUCKET = 'agent-payloads';

export type PayloadKind = 'input' | 'output';

export interface UploadPayloadParams {
  pipelineRunId: string;
  agent: string;
  retryCount: number;
  kind: PayloadKind;
  /** Anything JSON-serializable. */
  data: unknown;
}

export async function uploadPayload(params: UploadPayloadParams): Promise<string | null> {
  const sb = getSupabase();
  const day = new Date().toISOString().slice(0, 10);
  const objectPath = `${day}/${params.pipelineRunId}/${params.agent}-${params.retryCount}-${params.kind}.json`;
  const body = Buffer.from(JSON.stringify(params.data, null, 2), 'utf-8');

  const { data, error } = await sb.storage.from(PAYLOADS_BUCKET).upload(objectPath, body, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) {
    log.warn('Failed to upload payload', {
      agent: params.agent,
      kind: params.kind,
      objectPath,
      error: error.message,
    });
    return null;
  }
  const finalPath = data?.path ?? objectPath;
  log.info('Uploaded agent payload', {
    agent: params.agent,
    kind: params.kind,
    path: finalPath,
    bytes: body.byteLength,
  });
  return finalPath;
}
