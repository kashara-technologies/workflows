// Shared types for the Kashara SDLC orchestrator.
// Schema versions match docs/sdlc-pipeline-design.md.

export type AgentName = 'planner' | 'coder' | 'tester' | 'reviewer';

export type RunStatus = 'success' | 'failure' | 'timeout' | 'blocked';

export interface RunContext {
  /** Unique ID for this pipeline run (UUID). */
  pipelineRunId: string;
  /** Path to the PRD that triggered the run, e.g. "docs/product/pulse/auth.md". */
  prdPath: string;
  /** Product slug derived from PRD path, e.g. "pulse". */
  product: string;
  /** Feature slug derived from PRD filename, e.g. "auth". */
  feature: string;
  /** Git SHA of the PRD at the start of the run. */
  prdSha: string;
  /** SHA-256 of the PRD file content (not the commit). Used for idempotency skip checks. */
  prdContentSha: string;
  /** Git SHA of the repo state at the start of the run. */
  repoSha: string;
  /** Repo on GitHub (org/name format). */
  repo: string;
  /** Absolute path to the checked-out repo on the runner. */
  repoPath: string;
  /** Absolute path to the .kashara/build/<feature>/ directory. */
  artifactsPath: string;
  /** Build branch name, e.g. "build/auth". */
  buildBranch: string;
  /** Pipeline start time (ISO). */
  startedAt: string;
}

export interface AgentRunRecord {
  pipelineRunId: string;
  feature: string;
  product: string;
  prdPath: string;
  agent: AgentName;
  retryCount: number;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  promptHash: string | null;
  inputPayloadPath: string | null;
  outputPayloadPath: string | null;
  errorMessage: string | null;
}
