// Append-only audit log for every shell call across all agents.
//
// Lives at .kashara/build/<feature>/99-audit.log per design doc section 5.
// One line per call, including denied calls. Committed alongside the other
// build artifacts so the human reviewer can replay what the agents did.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName } from '../types.js';

export interface AuditLogger {
  /** Append a record for a shell call that ran. */
  recordShell(args: {
    agent: AgentName;
    command: string;
    exitCode: number;
    durationMs: number;
  }): Promise<void>;
  /** Append a record for a shell call rejected by the denylist. */
  recordShellDenied(args: {
    agent: AgentName;
    command: string;
    reason: string;
  }): Promise<void>;
}

function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeOneLine(s: string): string {
  // Collapse newlines and tabs so each audit line stays a single line.
  return s.replace(/[\r\n\t]+/g, ' ').trim();
}

export function createAuditLogger(artifactsPath: string): AuditLogger {
  const logPath = path.join(artifactsPath, '99-audit.log');
  let dirEnsured = false;

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    await mkdir(artifactsPath, { recursive: true });
    dirEnsured = true;
  }

  return {
    async recordShell({ agent, command, exitCode, durationMs }) {
      await ensureDir();
      const line = `${new Date().toISOString()} [${agent}] [shell] ${escapeOneLine(command)} [exit=${exitCode}] [duration=${fmtDuration(durationMs)}]\n`;
      await appendFile(logPath, line, 'utf-8');
    },
    async recordShellDenied({ agent, command, reason }) {
      await ensureDir();
      const line = `${new Date().toISOString()} [${agent}] [shell-denied] ${escapeOneLine(command)} [reason=${reason}]\n`;
      await appendFile(logPath, line, 'utf-8');
    },
  };
}
