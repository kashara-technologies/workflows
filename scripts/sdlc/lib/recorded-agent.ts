// Recording wrapper around runAgent.
//
// Adds Supabase observability without leaking that concern into the planner /
// coder / tester / reviewer agent files. For each invocation:
//   1. Upload the input payload (system + user blocks + tool list) to the
//      agent-payloads bucket.
//   2. Run the agent.
//   3. On success: upload the output payload, insert an agent_runs row with
//      status=success and the resolved payload paths.
//   4. On failure: insert an agent_runs row with status=failure and the
//      error message, then re-throw.
//
// Observability is best-effort. Storage / DB outages never block the
// pipeline; they emit warnings and let the agent result through.

import { runAgent, type RunAgentParams, type RunAgentResult } from './anthropic.js';
import { insertAgentRun } from './agent-runs.js';
import { isDryRun, loadDryRunResult } from './dry-run.js';
import { uploadPayload } from './payload-storage.js';
import { emitAgentRunCompleted } from './posthog.js';
import { log } from './logger.js';
import type { AgentName } from '../types.js';
import type { RunContext } from '../types.js';

export interface RecordingMetadata {
  ctx: RunContext;
  agent: AgentName;
  /** 0 for the first attempt; 1, 2, 3 for coder retries. Other agents: 0. */
  retryCount: number;
}

export interface RecordedAgentParams extends RunAgentParams {
  recording: RecordingMetadata;
  /**
   * Inject an alternative implementation of runAgent. Defaults to the real
   * Anthropic SDK call. Used by failure-injection tests to simulate API
   * errors at the right boundary.
   */
  runAgentImpl?: (params: RunAgentParams) => Promise<RunAgentResult>;
}

function inputPayloadFor(params: RunAgentParams): unknown {
  return {
    model: params.model ?? null,
    system: params.system,
    userBlocks: params.userBlocks,
    tools: params.tools.map((t) => ({ name: 'name' in t ? t.name : null, type: t.type })),
    maxTokens: params.maxTokens ?? null,
    maxIterations: params.maxIterations ?? null,
  };
}

function outputPayloadFor(result: RunAgentResult): unknown {
  return {
    finalText: result.finalText,
    turns: result.turns,
    usage: result.usage,
    costUsd: result.costUsd,
  };
}

export async function runRecordedAgent(params: RecordedAgentParams): Promise<RunAgentResult> {
  const { recording, runAgentImpl, ...runArgs } = params;
  // Dry-run takes precedence over both injected impl and the real SDK so
  // SDLC_DRY_RUN=1 always short-circuits, even if a caller passes its own
  // runAgentImpl. Tests that want to override dry-run can unset the env.
  const runner =
    isDryRun() && !runAgentImpl
      ? async (_params: RunAgentParams) => loadDryRunResult(recording.agent)
      : (runAgentImpl ?? runAgent);
  const { ctx, agent, retryCount } = recording;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const model = runArgs.model ?? 'claude-opus-4-7';

  // Best-effort input payload upload before the call. Failure logs a warning;
  // we still proceed with the agent.
  const inputPayloadPath = await safe(() =>
    uploadPayload({
      pipelineRunId: ctx.pipelineRunId,
      agent,
      retryCount,
      kind: 'input',
      data: inputPayloadFor(runArgs),
    }),
  );

  let result: RunAgentResult;
  try {
    result = await runner(runArgs);
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    await safe(() =>
      insertAgentRun({
        pipelineRunId: ctx.pipelineRunId,
        featurePath: ctx.prdPath,
        product: ctx.product,
        agent,
        retryCount,
        model,
        startedAt,
        finishedAt,
        status: 'failure',
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costUsd: null,
        promptHash: null,
        inputPayloadPath,
        outputPayloadPath: null,
        errorMessage: (err as Error).message,
      }),
    );
    emitAgentRunCompleted({
      pipelineRunId: ctx.pipelineRunId,
      agent,
      product: ctx.product,
      feature: ctx.feature,
      model,
      status: 'failure',
      durationMs,
      costUsd: null,
      retryCount,
    });
    throw err;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const outputPayloadPath = await safe(() =>
    uploadPayload({
      pipelineRunId: ctx.pipelineRunId,
      agent,
      retryCount,
      kind: 'output',
      data: outputPayloadFor(result),
    }),
  );

  await safe(() =>
    insertAgentRun({
      pipelineRunId: ctx.pipelineRunId,
      featurePath: ctx.prdPath,
      product: ctx.product,
      agent,
      retryCount,
      model,
      startedAt,
      finishedAt,
      status: 'success',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cacheReadInputTokens,
      costUsd: result.costUsd,
      promptHash: null,
      inputPayloadPath,
      outputPayloadPath,
      errorMessage: null,
    }),
  );

  emitAgentRunCompleted({
    pipelineRunId: ctx.pipelineRunId,
    agent,
    product: ctx.product,
    feature: ctx.feature,
    model,
    status: 'success',
    durationMs,
    costUsd: result.costUsd,
    retryCount,
  });

  return result;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.warn('Recorded-agent side-effect failed (continuing)', {
      error: (err as Error).message,
    });
    return null;
  }
}
