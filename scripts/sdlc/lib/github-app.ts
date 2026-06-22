// GitHub App authentication for the kashara-orchestrator App.
// Mints short-lived installation access tokens used to push and to open PRs.

import { createAppAuth } from '@octokit/auth-app';
import { getEnv } from './env.js';
import { log } from './logger.js';

let _cachedToken: { token: string; expiresAt: number } | null = null;

export interface InstallationTokenInfo {
  token: string;
  permissions: Record<string, string>;
  repositorySelection: string;
  repositoryNames: string[];
}

export async function mintInstallationToken(): Promise<InstallationTokenInfo> {
  const env = getEnv();
  const auth = createAppAuth({
    appId: env.ORCHESTRATOR_APP_ID,
    privateKey: env.ORCHESTRATOR_APP_PRIVATE_KEY,
    installationId: env.ORCHESTRATOR_APP_INSTALLATION_ID,
  });
  const result = await auth({ type: 'installation' });
  return {
    token: result.token,
    permissions: (result.permissions ?? {}) as Record<string, string>,
    repositorySelection: result.repositorySelection ?? 'unknown',
    repositoryNames: result.repositoryNames ?? [],
  };
}

export async function getInstallationToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && _cachedToken.expiresAt - now > 60) {
    return _cachedToken.token;
  }
  const env = getEnv();
  const auth = createAppAuth({
    appId: env.ORCHESTRATOR_APP_ID,
    privateKey: env.ORCHESTRATOR_APP_PRIVATE_KEY,
    installationId: env.ORCHESTRATOR_APP_INSTALLATION_ID,
  });
  const result = await auth({ type: 'installation' });
  const expiresAt = Math.floor(new Date(result.expiresAt).getTime() / 1000);
  _cachedToken = { token: result.token, expiresAt };
  return result.token;
}

/**
 * Verifies the installation token actually has the permissions required to
 * push code and open PRs against the target repo. Logs the token's permissions
 * and repository scope. Throws a descriptive error if anything is missing so
 * the orchestrator surfaces a clear failure before agents waste API spend.
 */
export async function assertCanWriteToRepo(targetRepo: string): Promise<void> {
  const info = await mintInstallationToken();
  log.info('GitHub App installation token minted', {
    repositorySelection: info.repositorySelection,
    repositoryCount: info.repositoryNames.length,
    repositoryNames: info.repositoryNames,
    permissions: info.permissions,
  });

  const repoName = targetRepo.split('/')[1] ?? targetRepo;
  if (info.repositorySelection === 'selected') {
    if (info.repositoryNames.length === 0) {
      throw new Error(
        `kashara-orchestrator App installation (${process.env.ORCHESTRATOR_APP_INSTALLATION_ID}) ` +
          `has repository_selection=selected but ZERO selected repositories. ` +
          `Fix: open the App installation settings page and either pick "All repositories" ` +
          `or add ${repoName} (plus the other product repos) under "Only select repositories".`,
      );
    }
    if (!info.repositoryNames.includes(repoName)) {
      throw new Error(
        `kashara-orchestrator App is installed with repository_selection=selected, ` +
          `and ${repoName} is NOT in the selected list. Selected: ${info.repositoryNames.join(', ')}. ` +
          `Fix: open the App installation settings and add ${repoName}.`,
      );
    }
  }

  const contents = info.permissions.contents;
  if (contents !== 'write') {
    throw new Error(
      `kashara-orchestrator App installation token does not have contents:write ` +
        `(got contents=${contents ?? 'undefined'}). This usually means the App's ` +
        `permission was upgraded after install and the org admin must re-accept the ` +
        `new permissions on the installation page.`,
    );
  }

  log.info('App installation can write to target repo', { repo: targetRepo });
}
