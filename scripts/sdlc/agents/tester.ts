// Tester agent.
//
// Reads PRD + plan + Coder summary, runs the project's standard checks via
// the shell tool, walks acceptance criteria, and writes a structured
// 03-test-results.md. Returns a parsed pass/fail decision the orchestrator
// uses to drive the retry loop.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RunAgentResult } from '../lib/anthropic.js';
import { runRecordedAgent } from '../lib/recorded-agent.js';
import type { AuditLogger } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import {
  FS_READ_TOOLS,
  createFsReadSandbox,
  dispatchFsReadTool,
} from '../lib/tools/fs-read.js';
import {
  SHELL_TOOL,
  createShellSandbox,
  dispatchShellTool,
} from '../lib/tools/shell.js';
import type { RunContext } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTER_PROMPT_PATH = path.resolve(__dirname, '..', '..', '..', 'prompts', 'agents', 'tester.md');

export type TesterDecision = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface TesterInput {
  ctx: RunContext;
  /** Plan path relative to repo root. */
  planRelPath: string;
  /** Summary path relative to repo root. */
  summaryRelPath: string;
  audit: AuditLogger;
}

export interface TesterOutput {
  testResultsPath: string;
  testResultsMarkdown: string;
  decision: TesterDecision;
  agentResult: RunAgentResult;
}

export async function runTester(input: TesterInput): Promise<TesterOutput> {
  const { ctx, audit, planRelPath, summaryRelPath } = input;
  log.info('Tester starting', {
    pipelineRunId: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
  });

  const systemPrompt = await readFile(TESTER_PROMPT_PATH, 'utf-8');
  const prdContent = await readFile(path.join(ctx.repoPath, ctx.prdPath), 'utf-8');
  const planContent = await readFile(path.join(ctx.repoPath, planRelPath), 'utf-8');
  const summaryContent = await readFile(path.join(ctx.repoPath, summaryRelPath), 'utf-8');

  const readSandbox = await createFsReadSandbox(ctx.repoPath);
  const shellSandbox = await createShellSandbox({
    repoPath: ctx.repoPath,
    audit,
    agent: 'tester',
  });

  const preamble =
    `You are testing feature "${ctx.feature}" for product "${ctx.product}".\n` +
    `Repository: ${ctx.repo}\n` +
    `Build branch: ${ctx.buildBranch}\n`;

  const prdBlock = `## PRD: ${ctx.prdPath}\n\n${prdContent}`;
  const planBlock = `## Plan: ${planRelPath}\n\n${planContent}`;
  const summaryBlock = `## Coder summary: ${summaryRelPath}\n\n${summaryContent}`;

  const closing =
    'Run the project checks, walk the acceptance criteria, decide PASS or FAIL, ' +
    'and emit the 03-test-results.md content as your final assistant message.';

  const result = await runRecordedAgent({
    recording: { ctx, agent: 'tester', retryCount: 0 },
    agentName: 'tester',
    system: [{ type: 'text', text: systemPrompt, cacheControl: 'ephemeral' }],
    userBlocks: [
      { type: 'text', text: preamble },
      { type: 'text', text: prdBlock, cacheControl: 'ephemeral' },
      { type: 'text', text: planBlock, cacheControl: 'ephemeral' },
      { type: 'text', text: summaryBlock },
      { type: 'text', text: closing },
    ],
    tools: [...FS_READ_TOOLS, SHELL_TOOL],
    handleTool: async (toolName, toolInput) => {
      const readResult = await dispatchFsReadTool(readSandbox, toolName, toolInput);
      if (readResult !== null) return readResult;
      const shellResult = await dispatchShellTool(shellSandbox, toolName, toolInput);
      if (shellResult !== null) return shellResult;
      throw new Error(`Unknown tool: ${toolName}`);
    },
    maxTokens: 8192,
    maxIterations: 40,
  });

  const testResultsMarkdown = stripCodeFences(result.finalText.trim());
  if (!testResultsMarkdown) {
    throw new Error('Tester produced an empty final response');
  }

  const testResultsPath = path.join(ctx.artifactsPath, '03-test-results.md');
  await mkdir(ctx.artifactsPath, { recursive: true });
  await writeFile(testResultsPath, testResultsMarkdown + '\n', 'utf-8');

  const decision = parseDecision(testResultsMarkdown);

  log.info('Tester wrote results', {
    testResultsPath,
    bytes: testResultsMarkdown.length,
    decision,
    turns: result.turns,
    costUsd: result.costUsd,
  });

  return { testResultsPath, testResultsMarkdown, decision, agentResult: result };
}

/**
 * Extracts the PASS / FAIL decision from the Markdown. Looks for the first
 * non-empty line under a "## Decision" heading and checks if it equals PASS
 * or FAIL (case insensitive, trimmed).
 */
export function parseDecision(markdown: string): TesterDecision {
  const lines = markdown.split('\n');
  let inDecisionSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+Decision\b/i.test(line)) {
      inDecisionSection = true;
      continue;
    }
    if (inDecisionSection) {
      if (line === '') continue;
      if (line.startsWith('#')) return 'UNKNOWN';
      const upper = line.toUpperCase();
      if (upper === 'PASS' || upper.startsWith('PASS ') || upper.startsWith('PASS.')) return 'PASS';
      if (upper === 'FAIL' || upper.startsWith('FAIL ') || upper.startsWith('FAIL.')) return 'FAIL';
      return 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

function stripCodeFences(text: string): string {
  const fenceMatch = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return text;
}
