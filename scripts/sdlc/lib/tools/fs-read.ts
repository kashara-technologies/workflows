// Read-only filesystem tools exposed to agents.
//
// Every path is interpreted as relative to the target repo root and validated
// to remain inside it. Symlinks that resolve outside the repo are rejected.
//
// Tools:
//   list_dir(path)  -> JSON describing entries at the given relative dir
//   read_file(path) -> file contents (truncated past MAX_BYTES)

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';

const MAX_FILE_BYTES = 200_000;
const MAX_LIST_ENTRIES = 500;

// Directories an agent never needs to inspect. Saves tokens and avoids leaking
// caches or vendored code into the conversation.
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.cache',
  'dist',
  'build',
  '.kashara',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
]);

export class PathOutsideRepoError extends Error {
  constructor(p: string) {
    super(`Path resolves outside the repo sandbox: ${p}`);
    this.name = 'PathOutsideRepoError';
  }
}

export interface FsReadSandbox {
  /** Absolute, real path to the repo root on disk. */
  readonly rootReal: string;
}

export async function createFsReadSandbox(repoPath: string): Promise<FsReadSandbox> {
  const rootReal = await realpath(repoPath);
  return { rootReal };
}

async function resolveInside(sandbox: FsReadSandbox, rel: string): Promise<string> {
  if (typeof rel !== 'string') {
    throw new Error(`Path must be a string, got ${typeof rel}`);
  }
  // Reject absolute paths outright; relative-only model.
  if (path.isAbsolute(rel)) {
    throw new PathOutsideRepoError(rel);
  }
  const joined = path.resolve(sandbox.rootReal, rel);
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    // File may not exist yet; fall back to the lexical resolution so we can
    // still surface a not-found error from the caller's stat/read.
    real = joined;
  }
  if (real !== sandbox.rootReal && !real.startsWith(sandbox.rootReal + path.sep)) {
    throw new PathOutsideRepoError(rel);
  }
  return real;
}

export interface ListDirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
}

export async function listDir(sandbox: FsReadSandbox, rel: string): Promise<{
  path: string;
  truncated: boolean;
  entries: ListDirEntry[];
}> {
  const abs = await resolveInside(sandbox, rel === '' ? '.' : rel);
  const dirents = await readdir(abs, { withFileTypes: true });
  const filtered = dirents.filter((d) => !IGNORED_DIRS.has(d.name));
  const truncated = filtered.length > MAX_LIST_ENTRIES;
  const sliced = filtered.slice(0, MAX_LIST_ENTRIES);
  const entries: ListDirEntry[] = sliced.map((d) => {
    let type: ListDirEntry['type'];
    if (d.isDirectory()) type = 'dir';
    else if (d.isFile()) type = 'file';
    else if (d.isSymbolicLink()) type = 'symlink';
    else type = 'other';
    return { name: d.name, type };
  });
  // Sort dirs before files, alphabetically within each.
  entries.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    if (a.type === 'dir') return -1;
    if (b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  return { path: rel || '.', truncated, entries };
}

export async function readFileSafe(sandbox: FsReadSandbox, rel: string): Promise<{
  path: string;
  truncated: boolean;
  bytes: number;
  content: string;
}> {
  const abs = await resolveInside(sandbox, rel);
  const st = await stat(abs);
  if (!st.isFile()) {
    throw new Error(`Not a regular file: ${rel}`);
  }
  const bytes = st.size;
  if (bytes > MAX_FILE_BYTES) {
    const buf = await readFile(abs, { encoding: 'utf-8', flag: 'r' });
    return {
      path: rel,
      truncated: true,
      bytes,
      content: buf.slice(0, MAX_FILE_BYTES),
    };
  }
  const content = await readFile(abs, 'utf-8');
  return { path: rel, truncated: false, bytes, content };
}

/** Tool definitions to pass into the Anthropic Messages API. */
export const FS_READ_TOOLS: Tool[] = [
  {
    name: 'list_dir',
    description:
      'List files and subdirectories inside the target repository at a relative path. ' +
      'Passing an empty string or "." lists the repo root. Common build directories ' +
      '(node_modules, .git, dist, .next, etc.) are filtered out automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the repo root. Use "." or "" for the root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the target repository. The result is truncated ' +
      'at 200 KB to keep the conversation small. Returns an error if the path is a ' +
      'directory or escapes the repo sandbox.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the repo root.',
        },
      },
      required: ['path'],
    },
  },
];

export interface FsReadToolInput {
  path: string;
}

export async function dispatchFsReadTool(
  sandbox: FsReadSandbox,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  if (toolName !== 'list_dir' && toolName !== 'read_file') return null;
  const parsed = input as Partial<FsReadToolInput> | null | undefined;
  if (!parsed || typeof parsed.path !== 'string') {
    throw new Error(`Tool ${toolName}: missing string "path" input`);
  }
  if (toolName === 'list_dir') {
    const result = await listDir(sandbox, parsed.path);
    return JSON.stringify(result);
  }
  const result = await readFileSafe(sandbox, parsed.path);
  return JSON.stringify(result);
}
