// Anthropic API client wrapper for the SDLC pipeline.
//
// Provides:
//   * `runAgent`: drives a tool-use loop against the Messages API until the
//     model emits a final text response (no tool_use blocks).
//   * Prompt caching: callers mark which content blocks to cache via the
//     `cacheControl: 'ephemeral'` flag on system/user blocks.
//   * Token + cost accounting aggregated across all turns of the loop.
//
// Concurrency: not thread safe; one runAgent call at a time per process.

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUnion,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { getEnv } from './env.js';
import { log } from './logger.js';

// Pricing for Claude Opus 4.7 in USD per million tokens.
// Anthropic publishes these on their pricing page; update if rates change.
const OPUS_PRICING_PER_MTOK = {
  input: 15,
  output: 75,
  cacheWrite5m: 18.75,
  cacheRead: 1.5,
} as const;

export const OPUS_MODEL_ID = 'claude-opus-4-7';

export interface CacheableTextBlock {
  type: 'text';
  text: string;
  cacheControl?: 'ephemeral';
}

export interface RunAgentParams {
  /** Anthropic model id. Defaults to Opus 4.7. */
  model?: string;
  /** Hard cap on output tokens per turn. */
  maxTokens?: number;
  /** System prompt blocks. Mark the long, reusable ones with cacheControl. */
  system: CacheableTextBlock[];
  /** First user message content blocks. */
  userBlocks: CacheableTextBlock[];
  /** Tool definitions visible to the model. */
  tools: ToolUnion[];
  /** Async dispatcher for a `tool_use` block. Should return a string result. */
  handleTool: (toolName: string, input: unknown) => Promise<string>;
  /** Max number of tool-use cycles before bailing. */
  maxIterations?: number;
  /** Label used in log lines, e.g. "planner". */
  agentName: string;
}

export interface RunAgentResult {
  /** Concatenated text from the final assistant message (no tool_use blocks). */
  finalText: string;
  /** Number of model turns executed (one turn = one Messages.create call). */
  turns: number;
  /** Aggregated token usage across all turns. */
  usage: AggregateUsage;
  /** Estimated cost in USD across all turns. */
  costUsd: number;
}

export interface AggregateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function toBlockParam(block: CacheableTextBlock): TextBlockParam {
  const out: TextBlockParam = { type: 'text', text: block.text };
  if (block.cacheControl === 'ephemeral') {
    out.cache_control = { type: 'ephemeral' };
  }
  return out;
}

function addUsage(into: AggregateUsage, from: Usage): void {
  into.inputTokens += from.input_tokens ?? 0;
  into.outputTokens += from.output_tokens ?? 0;
  into.cacheReadInputTokens += from.cache_read_input_tokens ?? 0;
  into.cacheCreationInputTokens += from.cache_creation_input_tokens ?? 0;
}

function computeOpusCostUsd(usage: AggregateUsage): number {
  const inputCost = (usage.inputTokens / 1_000_000) * OPUS_PRICING_PER_MTOK.input;
  const outputCost = (usage.outputTokens / 1_000_000) * OPUS_PRICING_PER_MTOK.output;
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000) * OPUS_PRICING_PER_MTOK.cacheRead;
  const cacheCreateCost = (usage.cacheCreationInputTokens / 1_000_000) * OPUS_PRICING_PER_MTOK.cacheWrite5m;
  return Number((inputCost + outputCost + cacheReadCost + cacheCreateCost).toFixed(4));
}

function extractToolUses(message: Message): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

function extractText(message: Message): string {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const env = getEnv();
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const client = getClient();
  const model = params.model ?? OPUS_MODEL_ID;
  const maxTokens = params.maxTokens ?? 8192;
  const maxIterations = params.maxIterations ?? 20;

  const usage: AggregateUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: params.userBlocks.map(toBlockParam),
    },
  ];

  const systemBlocks: TextBlockParam[] = params.system.map(toBlockParam);

  let turns = 0;
  let finalText = '';

  for (let i = 0; i < maxIterations; i++) {
    turns++;
    log.info('Anthropic call', {
      agent: params.agentName,
      turn: turns,
      model,
      messages: messages.length,
    });

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      tools: params.tools,
      messages,
    });

    addUsage(usage, response.usage);

    const toolUses = extractToolUses(response);

    if (toolUses.length === 0) {
      finalText = extractText(response);
      log.info('Agent finished', {
        agent: params.agentName,
        turn: turns,
        stopReason: response.stop_reason,
        finalTextLength: finalText.length,
      });
      break;
    }

    // Append the assistant message verbatim, then a single user message
    // carrying tool_result blocks for every tool_use in order.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      log.info('Tool call', { agent: params.agentName, tool: tu.name, toolUseId: tu.id });
      let resultText: string;
      let isError = false;
      try {
        resultText = await params.handleTool(tu.name, tu.input);
      } catch (err) {
        isError = true;
        resultText = `Tool error: ${(err as Error).message}`;
        log.warn('Tool errored', {
          agent: params.agentName,
          tool: tu.name,
          error: (err as Error).message,
        });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultText,
        is_error: isError,
      });
    }

    messages.push({
      role: 'user',
      content: toolResults satisfies ContentBlockParam[],
    });

    if (response.stop_reason !== 'tool_use') {
      log.warn('Unexpected stop_reason while tool_use blocks present', {
        agent: params.agentName,
        stopReason: response.stop_reason,
      });
    }
  }

  if (!finalText) {
    throw new Error(
      `Agent ${params.agentName} did not produce a final text response within ${maxIterations} iterations`,
    );
  }

  const costUsd = computeOpusCostUsd(usage);
  log.info('Agent done', {
    agent: params.agentName,
    turns,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    costUsd,
  });

  return { finalText, turns, usage, costUsd };
}
