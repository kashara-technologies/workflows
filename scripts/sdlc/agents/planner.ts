// Planner agent.
//
// Reads the PRD plus the repo state, runs an Anthropic tool-use loop with
// list_dir / read_file / web_search available, and writes the resulting
// Markdown plan to .kashara/build/<feature>/01-plan.md.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RunAgentResult } from '../lib/anthropic.js';
import { runRecordedAgent } from '../lib/recorded-agent.js';
import { log } from '../lib/logger.js';
import {
  FS_READ_TOOLS,
  createFsReadSandbox,
  dispatchFsReadTool,
} from '../lib/tools/fs-read.js';
import { webSearchTool } from '../lib/tools/web-search.js';
import type { RunContext } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/sdlc/agents/planner.ts -> ../../../prompts/agents/planner.md
const PLANNER_PROMPT_PATH = path.resolve(__dirname, '..', '..', '..', 'prompts', 'agents', 'planner.md');

export interface PlannerOutput {
  /** Absolute path to the written 01-plan.md. */
  planPath: string;
  /** Raw Markdown content of the plan. */
  planMarkdown: string;
  /** Token / cost / turn stats from the Anthropic call. */
  agentResult: RunAgentResult;
}

export async function runPlanner(ctx: RunContext): Promise<PlannerOutput> {
  log.info('Planner starting', {
    pipelineRunId: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
  });

  const systemPrompt = await readFile(PLANNER_PROMPT_PATH, 'utf-8');
  const prdContent = await readFile(path.join(ctx.repoPath, ctx.prdPath), 'utf-8');

  const sandbox = await createFsReadSandbox(ctx.repoPath);

  const userPreamble =
    `You are planning feature "${ctx.feature}" for product "${ctx.product}".\n` +
    `Repository: ${ctx.repo}\n` +
    `PRD path (relative to repo root): ${ctx.prdPath}\n`;

  const prdBlock = `## PRD: ${ctx.prdPath}\n\n${prdContent}`;

  const closing =
    'Now read whatever parts of the repository you need, then produce the plan ' +
    'in the structure described in your system prompt. Emit only the Markdown ' +
    'plan as your final assistant message.';

  const result = await runRecordedAgent({
    recording: { ctx, agent: 'planner', retryCount: 0 },
    agentName: 'planner',
    system: [
      { type: 'text', text: systemPrompt, cacheControl: 'ephemeral' },
    ],
    userBlocks: [
      { type: 'text', text: userPreamble },
      { type: 'text', text: prdBlock, cacheControl: 'ephemeral' },
      { type: 'text', text: closing },
    ],
    tools: [...FS_READ_TOOLS, webSearchTool()],
    handleTool: async (toolName, input) => {
      const fsResult = await dispatchFsReadTool(sandbox, toolName, input);
      if (fsResult !== null) return fsResult;
      throw new Error(`Unknown tool: ${toolName}`);
    },
    maxTokens: 8192,
    // 30 wasn't enough for the pulse dashboard PRD (planner wandered through
    // 19 list_dir + 11 read_file calls without ever writing). 60 gives
    // headroom while the prompt's convergence rule does the actual job.
    maxIterations: 60,
  });

  const planMarkdown = stripCodeFences(result.finalText.trim());
  if (!planMarkdown) {
    throw new Error('Planner produced an empty final response');
  }

  const planPath = path.join(ctx.artifactsPath, '01-plan.md');
  await mkdir(ctx.artifactsPath, { recursive: true });
  await writeFile(planPath, planMarkdown + '\n', 'utf-8');

  log.info('Planner wrote plan', {
    planPath,
    bytes: planMarkdown.length,
    turns: result.turns,
    costUsd: result.costUsd,
  });

  return { planPath, planMarkdown, agentResult: result };
}

// If the model wrapped the whole plan in a single triple-backtick block, peel
// it off so the file on disk is clean Markdown. Otherwise return as-is.
function stripCodeFences(text: string): string {
  const fenceMatch = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return text;
}
