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

  // GH Actions provides these
  GITHUB_WORKSPACE: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_SHA: z.string().min(1),
  GITHUB_EVENT_NAME: z.string().min(1).optional(),
  GITHUB_REF: z.string().min(1).optional(),
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
