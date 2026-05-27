// Dry-run support.
//
// When SDLC_DRY_RUN is set ("1" or "true"), runRecordedAgent loads a JSON
// fixture per agent from scripts/sdlc/fixtures/<agent>.json instead of
// calling the Anthropic API. The fixture's shape matches RunAgentResult so
// the rest of the orchestrator never sees the difference; it gets a
// canned final text, zero token usage, and zero cost.
//
// Side effects (Supabase, PostHog, PR ops, git push, label updates) still
// fire. They are best-effort and tolerate the absence of real upstream
// traffic. A dry-run pipeline therefore still produces a real build PR with
// real artifacts, just stamped with the fixture content.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunAgentResult } from './anthropic.js';
import { log } from './logger.js';
import type { AgentName } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/sdlc/lib/dry-run.ts -> ../fixtures/<agent>.json
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

export function isDryRun(): boolean {
  const raw = process.env.SDLC_DRY_RUN;
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return lower === '1' || lower === 'true';
}

export async function loadDryRunResult(agent: AgentName): Promise<RunAgentResult> {
  const fixturePath = path.join(FIXTURES_DIR, `${agent}.json`);
  const raw = await readFile(fixturePath, 'utf-8');
  const parsed = JSON.parse(raw) as RunAgentResult;
  log.info('Dry-run: loaded agent fixture', {
    agent,
    fixturePath,
    finalTextBytes: parsed.finalText.length,
  });
  return parsed;
}
