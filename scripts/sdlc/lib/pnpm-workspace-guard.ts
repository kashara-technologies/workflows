// Guard against pnpm 10's auto-generated placeholder entries in
// `pnpm-workspace.yaml`.
//
// When pnpm install encounters a build-script-bearing dependency that isn't
// in `allowBuilds`, it appends an entry like `pkg: set this to true or false`
// and exits 1. If the coder agent leaves these placeholders in place, every
// downstream CI run on the build branch is dead on arrival and the tester
// stage burns budget reproducing a failure the placeholder already guaranteed.
//
// This guard runs (a) before the coder loop, so a stale main branch fails
// fast, and (b) after each coder iteration, so a coder that introduced new
// placeholders fails before the tester is invoked.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PLACEHOLDER_PATTERN = /^(\s*[^\s:]+):\s*set this to true or false\s*$/gm;

export class PnpmWorkspacePlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PnpmWorkspacePlaceholderError';
  }
}

export function assertNoPnpmWorkspacePlaceholders(
  repoPath: string,
  phase: 'preflight' | 'post-coder',
): void {
  const filePath = path.join(repoPath, 'pnpm-workspace.yaml');
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  const matches = [...content.matchAll(PLACEHOLDER_PATTERN)];
  if (matches.length === 0) return;

  const packages = matches.map((m) => (m[1] ?? '').trim()).join(', ');
  const origin =
    phase === 'preflight'
      ? 'present on the build branch before the coder ran (main likely has them too)'
      : 'introduced by the coder agent';
  throw new PnpmWorkspacePlaceholderError(
    `pnpm-workspace.yaml contains pnpm-10 placeholder entries (${origin}): ${packages}. ` +
      `Each "set this to true or false" must be replaced with a boolean before install will succeed. ` +
      `See prompts/agents/coder.md: "No unedited placeholders in config files."`,
  );
}
