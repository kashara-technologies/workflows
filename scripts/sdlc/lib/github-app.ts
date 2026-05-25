// GitHub App authentication for the kashara-orchestrator App.
// Mints short-lived installation access tokens used to push and to open PRs.

import { createAppAuth } from '@octokit/auth-app';
import { getEnv } from './env.js';

let _cachedToken: { token: string; expiresAt: number } | null = null;

export async function getInstallationToken(): Promise<string> {
  const env = getEnv();
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && _cachedToken.expiresAt - now > 60) {
    return _cachedToken.token;
  }
  const auth = createAppAuth({
    appId: env.ORCHESTRATOR_APP_ID,
    privateKey: env.ORCHESTRATOR_APP_PRIVATE_KEY,
    installationId: env.ORCHESTRATOR_APP_INSTALLATION_ID,
  });
  const result = await auth({ type: 'installation' });
  // expiresAt is an ISO string per @octokit/auth-app
  const expiresAt = Math.floor(new Date(result.expiresAt).getTime() / 1000);
  _cachedToken = { token: result.token, expiresAt };
  return result.token;
}
