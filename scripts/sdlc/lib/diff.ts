// Build-branch diff reader for the Reviewer.
//
// Computes `git diff --staged <base>` after `git add -A`, with lockfiles and
// binary assets excluded via pathspecs, and a hard byte cap so a giant feature
// does not blow past prompt context. When the cap fires, the helper returns a
// per-file change summary the reviewer can drill into with read_file.

import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 150_000;

// Files the Reviewer should not need to read patch-by-patch. The directory and
// extension globs are passed to git via :(exclude) pathspecs.
const EXCLUDE_PATHSPECS = [
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)package-lock.json',
  ':(exclude)yarn.lock',
  ':(exclude)*.svg',
  ':(exclude)*.png',
  ':(exclude)*.jpg',
  ':(exclude)*.jpeg',
  ':(exclude)*.gif',
  ':(exclude)*.ico',
  ':(exclude)*.webp',
  ':(exclude)*.woff',
  ':(exclude)*.woff2',
  ':(exclude)*.ttf',
  ':(exclude)*.eot',
  ':(exclude)*.otf',
  ':(exclude)*.pdf',
  ':(exclude)*.zip',
  ':(exclude)*.tar.gz',
  ':(exclude)*.bin',
  ':(exclude)*.wasm',
];

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

export interface ChangedFile {
  path: string;
  /** A, M, D, R, T, U, etc. Per git diff --numstat / --name-status. */
  status: string;
  additions: number;
  deletions: number;
}

export interface BuildDiff {
  baseRef: string;
  /** The full diff text. May be truncated; see `truncated`. */
  diff: string;
  /** True if `diff` was capped at maxBytes. */
  truncated: boolean;
  /** Byte length of the full diff before truncation. */
  totalBytes: number;
  /** Per-file summary of every changed file (after excludes). */
  changedFiles: ChangedFile[];
  /** Patterns whose changed files are not in `diff` (lockfiles, binaries). */
  excludedPathspecs: string[];
}

export interface ComputeBuildDiffParams {
  repoPath: string;
  baseRef?: string;
  maxBytes?: number;
}

/**
 * Stage every change in the working tree, then compute the diff vs `baseRef`
 * with the standard excludes applied. Caller is responsible for the fact that
 * `git add -A` is a side effect; the orchestrator calls this between Tester
 * PASS and the final commit, so staging now does not change the final outcome.
 */
export async function computeBuildDiff(params: ComputeBuildDiffParams): Promise<BuildDiff> {
  const { repoPath } = params;
  const baseRef = params.baseRef ?? 'origin/main';
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;

  await runGit(['add', '-A'], repoPath);

  // Numstat gives one row per changed file: "<adds>\t<dels>\t<path>".
  // For binary files numstat outputs "-\t-\t<path>", which we treat as 0/0.
  const numstatOut = await runGit(
    ['diff', '--cached', '--numstat', baseRef, '--', ...EXCLUDE_PATHSPECS],
    repoPath,
  );
  const statusOut = await runGit(
    ['diff', '--cached', '--name-status', baseRef, '--', ...EXCLUDE_PATHSPECS],
    repoPath,
  );

  const statusByPath = new Map<string, string>();
  for (const line of statusOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0]) continue;
    // Renames look like "R100\told\tnew"; key on the destination path.
    const code = parts[0].charAt(0);
    const path = parts[parts.length - 1]!;
    statusByPath.set(path, code);
  }

  const changedFiles: ChangedFile[] = [];
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const adds = parts[0] === '-' ? 0 : parseInt(parts[0]!, 10) || 0;
    const dels = parts[1] === '-' ? 0 : parseInt(parts[1]!, 10) || 0;
    const path = parts[2]!;
    changedFiles.push({
      path,
      status: statusByPath.get(path) ?? '?',
      additions: adds,
      deletions: dels,
    });
  }

  const diffOut = await runGit(
    ['diff', '--cached', baseRef, '--', ...EXCLUDE_PATHSPECS],
    repoPath,
  );

  const totalBytes = Buffer.byteLength(diffOut, 'utf-8');
  let diff = diffOut;
  let truncated = false;
  if (totalBytes > maxBytes) {
    // Slice on byte boundary, then back off to the last newline to avoid
    // splitting a UTF-8 codepoint or a diff hunk header mid-line.
    const sliced = Buffer.from(diffOut, 'utf-8').subarray(0, maxBytes).toString('utf-8');
    const lastNewline = sliced.lastIndexOf('\n');
    diff = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
    truncated = true;
  }

  return {
    baseRef,
    diff,
    truncated,
    totalBytes,
    changedFiles,
    excludedPathspecs: EXCLUDE_PATHSPECS,
  };
}

/** Render a per-file summary for the Reviewer when the diff is truncated. */
export function renderChangedFileTable(diff: BuildDiff): string {
  const lines = [
    `Total changed files: ${diff.changedFiles.length}`,
    `Total diff bytes (pre-truncation): ${diff.totalBytes}`,
    diff.truncated ? `Diff was TRUNCATED at the byte cap; use read_file to drill in.` : '',
    '',
    'File                                                            Status  +Add   -Del',
  ].filter(Boolean);
  for (const f of diff.changedFiles) {
    const path = f.path.length > 60 ? '...' + f.path.slice(-57) : f.path;
    lines.push(
      `${path.padEnd(60)}  ${f.status.padEnd(5)} ${String(f.additions).padStart(5)} ${String(f.deletions).padStart(5)}`,
    );
  }
  return lines.join('\n');
}
