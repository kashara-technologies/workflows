// Coder agent.
//
// Reads the PRD + plan (+ optional prior test results), runs a tool-use loop
// with list_dir / read_file / write_file / shell available, and writes the
// resulting Markdown summary to .kashara/build/<feature>/02-summary.md.
//
// The orchestrator handles git: nothing here commits or pushes.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, type RunAgentResult } from '../lib/anthropic.js';
import type { AuditLogger } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import {
  FS_READ_TOOLS,
  createFsReadSandbox,
  dispatchFsReadTool,
} from '../lib/tools/fs-read.js';
import {
  FS_WRITE_TOOL,
  createFsWriteSandbox,
  dispatchFsWriteTool,
} from '../lib/tools/fs-write.js';
import {
  SHELL_TOOL,
  createShellSandbox,
  dispatchShellTool,
} from '../lib/tools/shell.js';
import type { RunContext } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODER_PROMPT_PATH = path.resolve(__dirname, '..', '..', '..', 'prompts', 'agents', 'coder.md');

export interface CoderInput {
  ctx: RunContext;
  /** Path to 01-plan.md (relative to repo root). */
  planRelPath: string;
  /** Path to prior 03-test-results.md on retry, otherwise undefined. */
  previousTestResultsRelPath?: string;
  /** Retry counter starting at 0 for the first attempt. */
  retryCount: number;
  audit: AuditLogger;
}

export interface CoderOutput {
  summaryPath: string;
  summaryMarkdown: string;
  agentResult: RunAgentResult;
}

export async function runCoder(input: CoderInput): Promise<CoderOutput> {
  const { ctx, audit, retryCount, planRelPath, previousTestResultsRelPath } = input;
  log.info('Coder starting', {
    pipelineRunId: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
    retryCount,
  });

  const systemPrompt = await readFile(CODER_PROMPT_PATH, 'utf-8');
  const prdContent = await readFile(path.join(ctx.repoPath, ctx.prdPath), 'utf-8');
  const planContent = await readFile(path.join(ctx.repoPath, planRelPath), 'utf-8');
  const priorTestResults = previousTestResultsRelPath
    ? await readFile(path.join(ctx.repoPath, previousTestResultsRelPath), 'utf-8')
    : null;

  const readSandbox = await createFsReadSandbox(ctx.repoPath);
  const writeSandbox = await createFsWriteSandbox(ctx.repoPath);
  const shellSandbox = await createShellSandbox({
    repoPath: ctx.repoPath,
    audit,
    agent: 'coder',
  });

  const preamble =
    `You are implementing feature "${ctx.feature}" for product "${ctx.product}".\n` +
    `Repository: ${ctx.repo}\n` +
    `Build branch: ${ctx.buildBranch}\n` +
    `Retry attempt: ${retryCount} of 3 max.\n`;

  const prdBlock = `## PRD: ${ctx.prdPath}\n\n${prdContent}`;
  const planBlock = `## Plan: ${planRelPath}\n\n${planContent}`;
  const retryBlock = priorTestResults
    ? `## Previous test results: ${previousTestResultsRelPath}\n\nThe last attempt failed the checks below. Fix specifically what failed; do not rewrite working code.\n\n${priorTestResults}`
    : null;

  const closing =
    'Survey the repository, implement the plan, and run the project checks as you go. ' +
    'When the implementation is complete (or in retry mode, the targeted fixes are complete), ' +
    'emit the 02-summary.md content as your final assistant message.';

  const userBlocks = [
    { type: 'text' as const, text: preamble },
    { type: 'text' as const, text: prdBlock, cacheControl: 'ephemeral' as const },
    { type: 'text' as const, text: planBlock, cacheControl: 'ephemeral' as const },
    ...(retryBlock ? [{ type: 'text' as const, text: retryBlock }] : []),
    { type: 'text' as const, text: closing },
  ];

  const result = await runAgent({
    agentName: 'coder',
    system: [{ type: 'text', text: systemPrompt, cacheControl: 'ephemeral' }],
    userBlocks,
    tools: [...FS_READ_TOOLS, FS_WRITE_TOOL, SHELL_TOOL],
    handleTool: async (toolName, toolInput) => {
      const readResult = await dispatchFsReadTool(readSandbox, toolName, toolInput);
      if (readResult !== null) return readResult;
      const writeResult = await dispatchFsWriteTool(writeSandbox, toolName, toolInput);
      if (writeResult !== null) return writeResult;
      const shellResult = await dispatchShellTool(shellSandbox, toolName, toolInput);
      if (shellResult !== null) return shellResult;
      throw new Error(`Unknown tool: ${toolName}`);
    },
    maxTokens: 8192,
    // Coder needs many tool calls (multiple writes + shells per file).
    maxIterations: 80,
  });

  const summaryMarkdown = stripCodeFences(result.finalText.trim());
  if (!summaryMarkdown) {
    throw new Error('Coder produced an empty final response');
  }

  const summaryPath = path.join(ctx.artifactsPath, '02-summary.md');
  await mkdir(ctx.artifactsPath, { recursive: true });
  await writeFile(summaryPath, summaryMarkdown + '\n', 'utf-8');

  log.info('Coder wrote summary', {
    summaryPath,
    bytes: summaryMarkdown.length,
    turns: result.turns,
    costUsd: result.costUsd,
  });

  return { summaryPath, summaryMarkdown, agentResult: result };
}

function stripCodeFences(text: string): string {
  const fenceMatch = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return text;
}
