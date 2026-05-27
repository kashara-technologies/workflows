// Git operations on the target repo, executed by the orchestrator using the
// kashara-orchestrator GitHub App installation token.
//
// Lifecycle for one pipeline run:
//   1. prepareBuildBranch: configure identity, swap actions/checkout's
//      extraheader for one carrying the App token, fetch base, check out
//      build/<feature> off origin/<base>.
//   2. (Agents run, writing into the working tree.)
//   3. commitAndPushBuildBranch: git add -A, commit if there's anything to
//      commit, and force-push to origin/build/<feature>.

import { spawn } from 'node:child_process';
import { getEnv } from './env.js';
import { log } from './logger.js';
import { getInstallationToken } from './github-app.js';

function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

export interface PrepareBuildBranchParams {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Set up the working tree so the orchestrator can write to the build branch
 * with the App's installation token. Call once at the start of a pipeline run.
 * Swaps actions/checkout's extraheader for one carrying the App token and
 * checks out build/<feature> off origin/<base>.
 */
export async function prepareBuildBranch(params: PrepareBuildBranchParams): Promise<void> {
  const {
    repoPath,
    branch,
    baseBranch = 'main',
    authorName = 'kashara-orchestrator[bot]',
    authorEmail = 'kashara-orchestrator[bot]@users.noreply.github.com',
  } = params;

  const token = await getInstallationToken();

  log.info('Preparing build branch', { branch, baseBranch });

  await runGit(['config', 'user.name', authorName], repoPath);
  await runGit(['config', 'user.email', authorEmail], repoPath);

  // actions/checkout@v4 stores the caller workflow's GITHUB_TOKEN in
  // http.https://github.com/.extraheader. That header overrides any
  // URL-embedded credentials, so swap it for one carrying the App token.
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64');
  await runGit(
    [
      'config',
      'http.https://github.com/.extraheader',
      `AUTHORIZATION: basic ${basicAuth}`,
    ],
    repoPath,
  );
  log.info('Replaced github.com extraheader with App installation token');

  await runGit(['fetch', 'origin', baseBranch, '--depth=1'], repoPath);
  await runGit(['checkout', '-B', branch, `origin/${baseBranch}`], repoPath);
}

export interface CommitAndPushBuildBranchParams {
  repoPath: string;
  branch: string;
  message: string;
  /**
   * If set, only these pathspecs are staged (instead of `git add -A`).
   * Used on crash to push the audit log + plan without committing
   * half-finished workspace mutations that could break downstream CI.
   */
  pathspec?: string[];
}

export interface CommitAndPushResult {
  branch: string;
  commitSha: string;
  /** True if a new commit was created; false if the working tree matched HEAD. */
  committed: boolean;
}

/**
 * Stage every change in the working tree, commit if there's something to
 * commit, and force-push to origin. Safe to call on an unchanged tree
 * (skips the commit but still pushes the branch tip).
 */
export async function commitAndPushBuildBranch(
  params: CommitAndPushBuildBranchParams,
): Promise<CommitAndPushResult> {
  const env = getEnv();
  const { repoPath, branch, message, pathspec } = params;

  if (pathspec && pathspec.length > 0) {
    await runGit(['add', '--', ...pathspec], repoPath);
  } else {
    await runGit(['add', '-A'], repoPath);
  }

  const status = await runGit(
    pathspec && pathspec.length > 0
      ? ['status', '--porcelain', '--', ...pathspec]
      : ['status', '--porcelain'],
    repoPath,
  );
  let committed = false;
  if (!status) {
    log.info('No changes to commit on build branch', { branch, pathspec });
  } else {
    await runGit(['commit', '-m', message], repoPath);
    committed = true;
  }

  await runGit(
    ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`],
    repoPath,
  );

  const commitSha = await runGit(['rev-parse', 'HEAD'], repoPath);
  log.info('Pushed build branch', { repo: env.GITHUB_REPOSITORY, branch, commitSha, committed });

  return { branch, commitSha, committed };
}
