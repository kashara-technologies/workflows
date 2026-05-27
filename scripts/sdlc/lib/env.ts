// Runtime env var validation.
// Throws fast if a required var is missing or empty.

import { z } from 'zod';

const Env = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  // GitHub App (kashara-orchestrator)
  ORCHESTRATOR_APP_ID: z.string().min(1),
  ORCHESTRATOR_APP_INSTALLATION_ID: z.string().min(1),
  ORCHESTRATOR_APP_PRIVATE_KEY: z.string().min(1),

  // Path to the target repo (the product repo, not the workflows repo).
  // Set by the workflow YAML.
  TARGET_REPO_PATH: z.string().min(1),

  // GH Actions provides these
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_SHA: z.string().min(1),
  GITHUB_EVENT_NAME: z.string().min(1).optional(),
  GITHUB_REF: z.string().min(1).optional(),

  // Optional opt-in monthly cost kill switch (USD). When set to a positive
  // number, the orchestrator queries agent_runs at startup and refuses to
  // start a new pipeline if current calendar month spend is over this value.
  // GitHub workflows pass empty strings for unset vars, so we accept any
  // string and validate at use time.
  SDLC_MONTHLY_KILL_SWITCH_USD: z.string().optional(),

  // Optional PostHog credentials. Both must be set for events to emit;
  // either one missing is treated as "telemetry disabled" and the pipeline
  // proceeds normally. EU instance per the Frankfurt residency posture.
  POSTHOG_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().optional(),

  // Dry-run mode. When SDLC_DRY_RUN is "1" or "true" the orchestrator
  // replays per-agent fixtures from scripts/sdlc/fixtures/ instead of
  // calling the Anthropic API. All other side effects (Supabase, PostHog,
  // PR ops) still run; they are best-effort and tolerate the missing
  // upstream traffic. Useful for prompt iteration, failure-injection
  // experiments, and demos that should not burn real tokens.
  SDLC_DRY_RUN: z.string().optional(),

  // Force re-run even if the build branch already has an APPROVED run for
  // the same PRD content. Default unset (skip on duplicate). Set to "1" or
  // "true" to bypass the idempotency check and always run the full pipeline.
  SDLC_FORCE_RERUN: z.string().optional(),
});

export type EnvVars = z.infer<typeof Env>;

let _env: EnvVars | null = null;

export function getEnv(): EnvVars {
  if (_env) return _env;
  const result = Env.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid env vars: ${missing}`);
  }
  _env = result.data;
  return _env;
}
