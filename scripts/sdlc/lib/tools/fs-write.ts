// Sandboxed file-write tool for the Coder agent.
//
// Writes any path inside the target repo working directory. Paths that escape
// the repo (via .. or absolute paths) are rejected. Parent directories are
// created as needed.

import { mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';

export class PathOutsideRepoError extends Error {
  constructor(p: string) {
    super(`Path resolves outside the repo sandbox: ${p}`);
    this.name = 'PathOutsideRepoError';
  }
}

export interface FsWriteSandbox {
  readonly rootReal: string;
}

export async function createFsWriteSandbox(repoPath: string): Promise<FsWriteSandbox> {
  const rootReal = await realpath(repoPath);
  return { rootReal };
}

async function resolveInsideForWrite(sandbox: FsWriteSandbox, rel: string): Promise<string> {
  if (typeof rel !== 'string') {
    throw new Error(`Path must be a string, got ${typeof rel}`);
  }
  if (path.isAbsolute(rel)) {
    throw new PathOutsideRepoError(rel);
  }
  const joined = path.resolve(sandbox.rootReal, rel);
  // For a write target the file may not exist yet, so check the realpath of
  // the closest existing ancestor instead. This blocks symlinks that escape
  // the repo via a parent dir.
  let probe = joined;
  while (probe !== sandbox.rootReal && probe !== path.dirname(probe)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const real = await realpath(probe);
      if (real !== sandbox.rootReal && !real.startsWith(sandbox.rootReal + path.sep)) {
        throw new PathOutsideRepoError(rel);
      }
      return joined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      probe = path.dirname(probe);
    }
  }
  // Probe walked all the way up to root; joined is inside root.
  if (joined !== sandbox.rootReal && !joined.startsWith(sandbox.rootReal + path.sep)) {
    throw new PathOutsideRepoError(rel);
  }
  return joined;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
  created: boolean;
}

export async function writeFileSafe(
  sandbox: FsWriteSandbox,
  rel: string,
  content: string,
): Promise<WriteFileResult> {
  const abs = await resolveInsideForWrite(sandbox, rel);
  let existedBefore = true;
  try {
    await stat(abs);
  } catch {
    existedBefore = false;
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  return { path: rel, bytes: Buffer.byteLength(content, 'utf-8'), created: !existedBefore };
}

export const FS_WRITE_TOOL: Tool = {
  name: 'write_file',
  description:
    'Write UTF-8 text to a file inside the target repository. Any parent directories that do not ' +
    'exist are created. The path must be relative to the repo root and stay inside it; absolute paths ' +
    'or paths that escape the sandbox are rejected. Use this for new source files, modifying existing ' +
    'files, and writing config (package.json edits, .env.example, etc.). Always read the file first if ' +
    'you intend to edit it; this tool overwrites without merging.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path relative to the repo root.',
      },
      content: {
        type: 'string',
        description: 'Full UTF-8 text content of the file.',
      },
    },
    required: ['path', 'content'],
  },
};

export interface FsWriteToolInput {
  path: string;
  content: string;
}

export async function dispatchFsWriteTool(
  sandbox: FsWriteSandbox,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  if (toolName !== 'write_file') return null;
  const parsed = input as Partial<FsWriteToolInput> | null | undefined;
  if (!parsed || typeof parsed.path !== 'string' || typeof parsed.content !== 'string') {
    throw new Error('Tool write_file: requires { path: string, content: string }');
  }
  const result = await writeFileSafe(sandbox, parsed.path, parsed.content);
  return JSON.stringify(result);
}
