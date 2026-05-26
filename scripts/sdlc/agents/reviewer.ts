// Reviewer agent.
//
// Reads PRD + plan + summary + test results + a pre-computed diff vs main,
// runs an Anthropic tool-use loop with list_dir + read_file available, and
// writes the resulting Markdown review to .kashara/build/<feature>/04-review.md.
// Parses APPROVE / BLOCK out of the final document so the orchestrator can
// drive the PR draft-state and label transitions.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, type RunAgentResult } from '../lib/anthropic.js';
import {
  computeBuildDiff,
  renderChangedFileTable,
  type BuildDiff,
} from '../lib/diff.js';
import { log } from '../lib/logger.js';
import {
  FS_READ_TOOLS,
  createFsReadSandbox,
  dispatchFsReadTool,
} from '../lib/tools/fs-read.js';
import type { RunContext } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVIEWER_PROMPT_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'prompts',
  'agents',
  'reviewer.md',
);

export type ReviewerDecision = 'APPROVE' | 'BLOCK' | 'UNKNOWN';

export interface ReviewerInput {
  ctx: RunContext;
  planRelPath: string;
  summaryRelPath: string;
  testResultsRelPath: string;
}

export interface ReviewerOutput {
  reviewPath: string;
  reviewMarkdown: string;
  decision: ReviewerDecision;
  /** First short line of justification under the decision, if any. */
  decisionRationale: string;
  /** The diff fed to the reviewer; useful for the PR description. */
  diff: BuildDiff;
  agentResult: RunAgentResult;
}

export async function runReviewer(input: ReviewerInput): Promise<ReviewerOutput> {
  const { ctx, planRelPath, summaryRelPath, testResultsRelPath } = input;
  log.info('Reviewer starting', {
    pipelineRunId: ctx.pipelineRunId,
    feature: ctx.feature,
    product: ctx.product,
  });

  const systemPrompt = await readFile(REVIEWER_PROMPT_PATH, 'utf-8');
  const prdContent = await readFile(path.join(ctx.repoPath, ctx.prdPath), 'utf-8');
  const planContent = await readFile(path.join(ctx.repoPath, planRelPath), 'utf-8');
  const summaryContent = await readFile(path.join(ctx.repoPath, summaryRelPath), 'utf-8');
  const testResultsContent = await readFile(
    path.join(ctx.repoPath, testResultsRelPath),
    'utf-8',
  );

  const diff = await computeBuildDiff({ repoPath: ctx.repoPath });
  log.info('Reviewer diff computed', {
    files: diff.changedFiles.length,
    totalBytes: diff.totalBytes,
    truncated: diff.truncated,
  });

  const readSandbox = await createFsReadSandbox(ctx.repoPath);

  const preamble =
    `You are reviewing feature "${ctx.feature}" for product "${ctx.product}".\n` +
    `Repository: ${ctx.repo}\n` +
    `Build branch: ${ctx.buildBranch}\n` +
    `Diff base: ${diff.baseRef}\n` +
    `Changed files: ${diff.changedFiles.length}\n` +
    `Total diff bytes: ${diff.totalBytes}${diff.truncated ? ' (TRUNCATED at cap)' : ''}\n`;

  const prdBlock = `## PRD: ${ctx.prdPath}\n\n${prdContent}`;
  const planBlock = `## Plan: ${planRelPath}\n\n${planContent}`;
  const summaryBlock = `## Coder summary: ${summaryRelPath}\n\n${summaryContent}`;
  const testResultsBlock = `## Test results: ${testResultsRelPath}\n\n${testResultsContent}`;

  const fileTable = renderChangedFileTable(diff);
  const diffBlock =
    `## Diff vs ${diff.baseRef}\n\n` +
    `### File summary\n\n\`\`\`\n${fileTable}\n\`\`\`\n\n` +
    `### Patch\n\n` +
    (diff.diff
      ? `\`\`\`diff\n${diff.diff}\n\`\`\`` +
        (diff.truncated
          ? `\n\n(The patch above is truncated. Use \`read_file\` on any file from the table to read the current state of that file on the build branch.)`
          : '')
      : '(empty diff)');

  const closing =
    'Read the PRD, plan, summary, test results, and the diff. Drill into specific files ' +
    'with read_file when you need more context. Apply the decision rules from the system ' +
    'prompt and emit the 04-review.md content as your final assistant message.';

  const result = await runAgent({
    agentName: 'reviewer',
    system: [{ type: 'text', text: systemPrompt, cacheControl: 'ephemeral' }],
    userBlocks: [
      { type: 'text', text: preamble },
      { type: 'text', text: prdBlock, cacheControl: 'ephemeral' },
      { type: 'text', text: planBlock, cacheControl: 'ephemeral' },
      { type: 'text', text: summaryBlock },
      { type: 'text', text: testResultsBlock },
      { type: 'text', text: diffBlock, cacheControl: 'ephemeral' },
      { type: 'text', text: closing },
    ],
    tools: [...FS_READ_TOOLS],
    handleTool: async (toolName, toolInput) => {
      const readResult = await dispatchFsReadTool(readSandbox, toolName, toolInput);
      if (readResult !== null) return readResult;
      throw new Error(`Unknown tool: ${toolName}`);
    },
    maxTokens: 8192,
    maxIterations: 25,
  });

  const reviewMarkdown = stripCodeFences(result.finalText.trim());
  if (!reviewMarkdown) {
    throw new Error('Reviewer produced an empty final response');
  }

  const reviewPath = path.join(ctx.artifactsPath, '04-review.md');
  await mkdir(ctx.artifactsPath, { recursive: true });
  await writeFile(reviewPath, reviewMarkdown + '\n', 'utf-8');

  const { decision, rationale } = parseReviewDecision(reviewMarkdown);

  log.info('Reviewer wrote review', {
    reviewPath,
    bytes: reviewMarkdown.length,
    decision,
    turns: result.turns,
    costUsd: result.costUsd,
  });

  return {
    reviewPath,
    reviewMarkdown,
    decision,
    decisionRationale: rationale,
    diff,
    agentResult: result,
  };
}

/**
 * Pull the APPROVE / BLOCK verdict out of the review document. Looks for the
 * first non-empty line under "## Decision" and matches case-insensitively.
 * Returns UNKNOWN when no decision line is found or the value is not one of
 * the two; the orchestrator treats UNKNOWN as BLOCK out of caution.
 */
export function parseReviewDecision(markdown: string): {
  decision: ReviewerDecision;
  rationale: string;
} {
  const lines = markdown.split('\n');
  let inDecisionSection = false;
  let pendingDecision: ReviewerDecision | null = null;
  let rationale = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+Decision\b/i.test(line)) {
      inDecisionSection = true;
      continue;
    }
    if (!inDecisionSection) continue;
    if (pendingDecision === null) {
      if (line === '') continue;
      if (line.startsWith('#')) return { decision: 'UNKNOWN', rationale: '' };
      const upper = line.toUpperCase();
      // Accept "APPROVE", "APPROVED", "APPROVE."  etc. Same for BLOCK.
      if (upper === 'APPROVE' || upper.startsWith('APPROVE ') || upper.startsWith('APPROVE.') || upper === 'APPROVED') {
        pendingDecision = 'APPROVE';
        continue;
      }
      if (upper === 'BLOCK' || upper.startsWith('BLOCK ') || upper.startsWith('BLOCK.') || upper === 'BLOCKED') {
        pendingDecision = 'BLOCK';
        continue;
      }
      return { decision: 'UNKNOWN', rationale: '' };
    } else {
      // Capture the first non-empty rationale line under the decision.
      if (line === '') continue;
      if (line.startsWith('#')) break;
      rationale = line;
      break;
    }
  }
  return { decision: pendingDecision ?? 'UNKNOWN', rationale };
}

function stripCodeFences(text: string): string {
  const fenceMatch = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return text;
}
