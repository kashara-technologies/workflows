// Sandboxed shell tool for the Coder and Tester agents.
//
// Every command:
//   1. Is checked against config/denylist.txt before exec.
//   2. Runs with cwd pinned to the target repo.
//   3. Has a hard 5-minute wall-clock cap (design doc section 5).
//   4. Has stdout + stderr captured and truncated for return to the model.
//   5. Is recorded in the audit log (both runs and denials).

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { AuditLogger } from '../audit.js';
import { log } from '../logger.js';
import type { AgentName } from '../../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/sdlc/lib/tools/shell.ts -> ../../../../config/denylist.txt
const DENYLIST_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'config', 'denylist.txt');

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const STDOUT_BYTES_RETURNED = 16_000;
const STDERR_BYTES_RETURNED = 8_000;

export interface DenylistMatch {
  pattern: string;
}

export class Denylist {
  constructor(private readonly patterns: { source: string; re: RegExp }[]) {}

  static async load(filepath: string = DENYLIST_PATH): Promise<Denylist> {
    const raw = await readFile(filepath, 'utf-8');
    const patterns: { source: string; re: RegExp }[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      patterns.push({ source: trimmed, re: new RegExp(trimmed) });
    }
    return new Denylist(patterns);
  }

  match(command: string): DenylistMatch | null {
    for (const p of this.patterns) {
      if (p.re.test(command)) return { pattern: p.source };
    }
    return null;
  }
}

export interface ShellRunResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

function truncate(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (buf.byteLength <= maxBytes) return { text: buf.toString('utf-8'), truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf-8'), truncated: true };
}

function runProcess(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-lc', command], { cwd, env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SHELL_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      const stdout = truncate(stdoutBuf, STDOUT_BYTES_RETURNED);
      const stderr = truncate(stderrBuf, STDERR_BYTES_RETURNED);
      const exitCode = code ?? (signal ? 124 : -1);
      resolve({
        command,
        exitCode,
        durationMs: Date.now() - started,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
      });
    });
  });
}

export interface ShellSandbox {
  readonly repoPath: string;
  readonly denylist: Denylist;
  readonly audit: AuditLogger;
  readonly agent: AgentName;
}

export interface CreateShellSandboxParams {
  repoPath: string;
  audit: AuditLogger;
  agent: AgentName;
  denylist?: Denylist;
}

export async function createShellSandbox(params: CreateShellSandboxParams): Promise<ShellSandbox> {
  const denylist = params.denylist ?? (await Denylist.load());
  return {
    repoPath: params.repoPath,
    denylist,
    audit: params.audit,
    agent: params.agent,
  };
}

export const SHELL_TOOL: Tool = {
  name: 'shell',
  description:
    'Run a single bash command in the target repository. The command runs with cwd at the repo root. ' +
    'A 5-minute timeout applies. Commands matching the denylist (force pushes, sudo, recursive deletes, ' +
    'publishing, etc.) are refused; the tool returns an error and the command does not execute. The stdout ' +
    'and stderr returned to you are truncated; if you need full output, write to a file and read it back.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'A single shell command line. Pipelines and && chains are allowed.',
      },
    },
    required: ['command'],
  },
};

export interface ShellToolInput {
  command: string;
}

export async function dispatchShellTool(
  sandbox: ShellSandbox,
  toolName: string,
  input: unknown,
): Promise<string | null> {
  if (toolName !== 'shell') return null;
  const parsed = input as Partial<ShellToolInput> | null | undefined;
  if (!parsed || typeof parsed.command !== 'string') {
    throw new Error('Tool shell: missing string "command" input');
  }
  const command = parsed.command;

  const denied = sandbox.denylist.match(command);
  if (denied) {
    await sandbox.audit.recordShellDenied({
      agent: sandbox.agent,
      command,
      reason: `denylist:${denied.pattern}`,
    });
    log.warn('Shell call denied', { agent: sandbox.agent, command, pattern: denied.pattern });
    return JSON.stringify({
      denied: true,
      pattern: denied.pattern,
      message:
        `Refused by denylist (pattern: ${denied.pattern}). The orchestrator handles force pushes, ` +
        `publishing, sudo, and similar destructive operations. Choose a different approach.`,
    });
  }

  const result = await runProcess(command, sandbox.repoPath, {
    ...process.env,
    // Force non-interactive package managers to avoid hanging on prompts.
    CI: '1',
    FORCE_COLOR: '0',
    PNPM_DIR: process.env.PNPM_DIR ?? '/home/runner/setup-pnpm',
  });

  await sandbox.audit.recordShell({
    agent: sandbox.agent,
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  });

  return JSON.stringify({
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
  });
}
