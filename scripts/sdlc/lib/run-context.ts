import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunContext } from '../types.js';
import { getEnv } from './env.js';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();
}

export function parsePrdPath(prdPath: string): { product: string; feature: string } {
  const match = prdPath.match(/^docs\/product\/([^/]+)\/([^/]+)\.md$/);
  if (!match) {
    throw new Error(`PRD path doesn't match expected pattern docs/product/<product>/<feature>.md: ${prdPath}`);
  }
  return { product: match[1]!, feature: match[2]! };
}

export function buildRunContext(prdPath: string): RunContext {
  const env = getEnv();
  const repoPath = env.TARGET_REPO_PATH;

  const { product, feature } = parsePrdPath(prdPath);
  const prdSha = git(`log -1 --format=%H -- ${prdPath}`, repoPath);
  if (!prdSha) {
    throw new Error(`PRD file ${prdPath} has no git history in ${repoPath}`);
  }

  const repoSha = env.GITHUB_SHA;
  const artifactsPath = path.join(repoPath, '.kashara', 'build', feature);
  const prdContent = readFileSync(path.join(repoPath, prdPath), 'utf-8');
  const prdContentSha = createHash('sha256').update(prdContent).digest('hex');

  return {
    pipelineRunId: randomUUID(),
    prdPath,
    product,
    feature,
    prdSha,
    prdContentSha,
    repoSha,
    repo: env.GITHUB_REPOSITORY,
    repoPath,
    artifactsPath,
    buildBranch: `build/${feature}`,
    startedAt: new Date().toISOString(),
  };
}
