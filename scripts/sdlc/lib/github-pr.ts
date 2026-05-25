// PR operations via the kashara-orchestrator GitHub App.
//
// Helpers for the orchestrator state machine:
//   * findOrCreateBuildPr: opens a PR from build/<feature> to main if none
//     exists, otherwise reuses the open one.
//   * setBuildLabel: removes any other build:* label on the PR and applies
//     the given one. Mirrors the design's single-active-label contract.
//   * postPrComment: posts a Markdown comment as the App.
//   * updatePrBody: edits the PR description (used to keep artifact links
//     current at the end of a run).
//
// All calls authenticate with the App installation token.

import { Octokit } from '@octokit/rest';
import { getEnv } from './env.js';
import { getInstallationToken } from './github-app.js';
import { log } from './logger.js';

export type BuildLabel =
  | 'build:planning'
  | 'build:coding'
  | 'build:testing'
  | 'build:reviewing'
  | 'build:approved'
  | 'build:blocked'
  | 'build:failed';

export const ALL_BUILD_LABELS: readonly BuildLabel[] = [
  'build:planning',
  'build:coding',
  'build:testing',
  'build:reviewing',
  'build:approved',
  'build:blocked',
  'build:failed',
] as const;

async function client(): Promise<Octokit> {
  const token = await getInstallationToken();
  return new Octokit({ auth: token });
}

function repoSlug(): { owner: string; repo: string } {
  const env = getEnv();
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY not in owner/repo format: ${env.GITHUB_REPOSITORY}`);
  }
  return { owner, repo };
}

export interface FindOrCreateBuildPrParams {
  branch: string;
  baseBranch: string;
  feature: string;
  initialBody: string;
}

export interface BuildPr {
  number: number;
  htmlUrl: string;
  created: boolean;
}

export async function findOrCreateBuildPr(params: FindOrCreateBuildPrParams): Promise<BuildPr> {
  const gh = await client();
  const { owner, repo } = repoSlug();
  const { branch, baseBranch, feature, initialBody } = params;

  // Search by branch head.
  const list = await gh.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'open',
    per_page: 1,
  });
  if (list.data.length > 0) {
    const existing = list.data[0]!;
    log.info('Reusing existing build PR', { number: existing.number, url: existing.html_url });
    return { number: existing.number, htmlUrl: existing.html_url, created: false };
  }

  const created = await gh.pulls.create({
    owner,
    repo,
    head: branch,
    base: baseBranch,
    title: `[build] ${feature}`,
    body: initialBody,
    draft: true,
  });
  log.info('Created build PR', { number: created.data.number, url: created.data.html_url });
  return { number: created.data.number, htmlUrl: created.data.html_url, created: true };
}

export interface SetBuildLabelParams {
  prNumber: number;
  label: BuildLabel;
}

export async function setBuildLabel(params: SetBuildLabelParams): Promise<void> {
  const gh = await client();
  const { owner, repo } = repoSlug();
  const { prNumber, label } = params;

  const current = await gh.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  for (const l of current.data) {
    if (ALL_BUILD_LABELS.includes(l.name as BuildLabel) && l.name !== label) {
      try {
        await gh.issues.removeLabel({ owner, repo, issue_number: prNumber, name: l.name });
      } catch (err) {
        log.warn('Failed to remove stale build label', { label: l.name, error: (err as Error).message });
      }
    }
  }

  await gh.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: [label],
  });
  log.info('Set build label', { prNumber, label });
}

export interface PostPrCommentParams {
  prNumber: number;
  body: string;
}

export async function postPrComment(params: PostPrCommentParams): Promise<void> {
  const gh = await client();
  const { owner, repo } = repoSlug();
  await gh.issues.createComment({
    owner,
    repo,
    issue_number: params.prNumber,
    body: params.body,
  });
  log.info('Posted PR comment', { prNumber: params.prNumber, bytes: params.body.length });
}

export interface UpdatePrBodyParams {
  prNumber: number;
  body: string;
}

export async function updatePrBody(params: UpdatePrBodyParams): Promise<void> {
  const gh = await client();
  const { owner, repo } = repoSlug();
  await gh.pulls.update({
    owner,
    repo,
    pull_number: params.prNumber,
    body: params.body,
  });
  log.info('Updated PR body', { prNumber: params.prNumber, bytes: params.body.length });
}

export interface UpdatePrStateParams {
  prNumber: number;
  draft: boolean;
}

/**
 * Toggle draft / ready-for-review. Requires the GraphQL endpoint because the
 * REST update endpoint can only convert ready-for-review, not back to draft.
 * For Phase D we only need to flip OUT of draft on PASS; reviewer/blocked
 * states stay as draft.
 */
export async function markPrReadyForReview(prNumber: number): Promise<void> {
  const gh = await client();
  const { owner, repo } = repoSlug();
  // Fetch the PR's node id for GraphQL.
  const pr = await gh.pulls.get({ owner, repo, pull_number: prNumber });
  const nodeId = pr.data.node_id;
  await gh.graphql(
    `mutation($id: ID!) {
       markPullRequestReadyForReview(input: { pullRequestId: $id }) {
         pullRequest { number }
       }
     }`,
    { id: nodeId },
  );
  log.info('Marked PR ready for review', { prNumber });
}
