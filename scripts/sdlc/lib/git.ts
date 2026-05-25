// Git operations on the target repo, executed by the orchestrator using the
// kashara-orchestrator GitHub App installation token.
//
// Scope intentionally narrow for Phase C:
//   * `commitAndPushArtifacts` creates / resets a build/<feature> branch off
//     main, commits one or more files, and force-pushes it to origin.

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

export interface CommitAndPushParams {
  /** Path to the checked-out target repo. */
  repoPath: string;
  /** Branch name to push to, e.g. "build/auth". */
  branch: string;
  /** Base branch to fork from when the build branch is new. */
  baseBranch?: string;
  /** Paths (relative to repoPath) to add and commit. */
  paths: string[];
  /** Commit message. */
  message: string;
  /** Commit author/committer identity. */
  authorName?: string;
  authorEmail?: string;
}

export async function commitAndPushArtifacts(params: CommitAndPushParams): Promise<{
  commitSha: string;
  branch: string;
}> {
  const env = getEnv();
  const {
    repoPath,
    branch,
    baseBranch = 'main',
    paths,
    message,
    authorName = 'kashara-orchestrator[bot]',
    authorEmail = 'kashara-orchestrator[bot]@users.noreply.github.com',
  } = params;

  const token = await getInstallationToken();
  const remoteUrl = `https://x-access-token:${token}@github.com/${env.GITHUB_REPOSITORY}.git`;

  log.info('Preparing build branch', { branch, baseBranch, paths: paths.length });

  // Configure identity locally for this repo only.
  await runGit(['config', 'user.name', authorName], repoPath);
  await runGit(['config', 'user.email', authorEmail], repoPath);

  // Ensure we have an up-to-date base.
  await runGit(['fetch', 'origin', baseBranch, '--depth=1'], repoPath);

  // Recreate the branch from base. Force semantics: every pipeline run rebuilds
  // the branch from main, then force-pushes. Matches the design's "force-push
  // on subsequent runs" behavior.
  await runGit(['checkout', '-B', branch, `origin/${baseBranch}`], repoPath);

  await runGit(['add', '--', ...paths], repoPath);

  // If nothing changed (e.g. plan identical to a prior run), skip the commit.
  const status = await runGit(['status', '--porcelain'], repoPath);
  if (!status) {
    log.info('No changes to commit; pushing branch as-is');
  } else {
    await runGit(['commit', '-m', message], repoPath);
  }

  // Push with the App token. Force-with-lease is too restrictive here since we
  // reset the branch from main; use plain force-push consistent with the
  // design's contract.
  await runGit(['push', '--force', remoteUrl, `HEAD:refs/heads/${branch}`], repoPath);

  const commitSha = await runGit(['rev-parse', 'HEAD'], repoPath);
  log.info('Pushed build branch', { branch, commitSha });

  return { commitSha, branch };
}
