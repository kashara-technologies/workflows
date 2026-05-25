// Per-agent milestone comment templates.
//
// Format follows docs/sdlc-pipeline-design.md section 7. Brand rule: no em
// dashes or en dashes anywhere in the output; use commas.

import type { AgentName } from '../types.js';
import type { RunAgentResult } from './anthropic.js';

const ICON: Record<string, string> = {
  success: '✅',
  warning: '⚠️',
  failure: '❌',
};

const MODEL_LABEL: Record<string, string> = {
  'claude-opus-4-7': 'Opus 4.7',
};

function shortModel(model: string): string {
  return MODEL_LABEL[model] ?? model;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function formatDollars(usd: number | null | undefined): string {
  if (usd == null) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function formatDuration(turns: number): string {
  // We don't actually measure wall clock end-to-end here; the orchestrator
  // logs it. Show turns + an approximation only if available.
  return `${turns} turn${turns === 1 ? '' : 's'}`;
}

function artifactLink(artifactPath: string, repo: string, branch: string): string {
  return `[${artifactPath}](https://github.com/${repo}/blob/${branch}/${artifactPath})`;
}

export interface MilestoneCommentParams {
  agent: AgentName;
  model: string;
  agentResult: RunAgentResult;
  /** Artifact path relative to repo root, e.g. ".kashara/build/auth/01-plan.md" */
  artifactPath: string;
  repo: string;
  branch: string;
  /** Optional one-line tagline below the header. */
  tagline?: string;
}

export function milestoneComment(params: MilestoneCommentParams): string {
  const u = params.agentResult.usage;
  const header =
    `${ICON.success} **${cap(params.agent)} complete** ` +
    `(${shortModel(params.model)}, ` +
    `${formatTokens(u.inputTokens)} input / ${formatTokens(u.outputTokens)} output, ` +
    `${formatTokens(u.cacheReadInputTokens)} cache reads, ` +
    `${formatDollars(params.agentResult.costUsd)}, ` +
    `${formatDuration(params.agentResult.turns)})`;
  const link = `Artifact: ${artifactLink(params.artifactPath, params.repo, params.branch)}`;
  const tagline = params.tagline ? `\n${params.tagline}` : '';
  return `${header}\n${link}${tagline}`;
}

export interface CoderRetryCommentParams {
  attemptNumber: number; // 1-indexed
  maxRetries: number;
  failureSummary: string; // short, no leading newline
}

export function coderRetryComment(params: CoderRetryCommentParams): string {
  return (
    `${ICON.warning} **Coder retry ${params.attemptNumber} of ${params.maxRetries}**, tests failed.\n` +
    `${params.failureSummary}\n` +
    `Coder will attempt fixes.`
  );
}

export interface FinalCommentParams {
  decision: 'pass' | 'fail';
  feature: string;
  repo: string;
  branch: string;
  artifactDir: string;
  commitSha: string;
  totalCostUsd: number;
  totalTurns: number;
  retriesUsed: number;
}

export function finalComment(params: FinalCommentParams): string {
  const icon = params.decision === 'pass' ? ICON.success : ICON.failure;
  const verdict = params.decision === 'pass' ? 'PASS' : 'FAIL';
  const lines = [
    `${icon} **Pipeline ${verdict}** for ${params.feature}`,
    ``,
    `Commit: \`${params.commitSha.slice(0, 7)}\` on \`${params.branch}\``,
    `Retries used: ${params.retriesUsed}`,
    `Total cost: ${formatDollars(params.totalCostUsd)}`,
    `Total turns: ${params.totalTurns}`,
    ``,
    `Artifacts:`,
    `- [01-plan.md](https://github.com/${params.repo}/blob/${params.branch}/${params.artifactDir}/01-plan.md)`,
    `- [02-summary.md](https://github.com/${params.repo}/blob/${params.branch}/${params.artifactDir}/02-summary.md)`,
    `- [03-test-results.md](https://github.com/${params.repo}/blob/${params.branch}/${params.artifactDir}/03-test-results.md)`,
    `- [99-audit.log](https://github.com/${params.repo}/blob/${params.branch}/${params.artifactDir}/99-audit.log)`,
  ];
  return lines.join('\n');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
