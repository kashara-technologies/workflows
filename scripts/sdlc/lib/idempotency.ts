// Idempotency check: skip the pipeline when the same PRD content was already
// approved on the build branch.
//
// Why: a re-push of the same PRD trigger (e.g. duplicate "feat: ship X via
// SDLC" commits four hours apart) burns ~$12 to rebuild a feature that was
// already approved. The post-mortem for the first auth run flagged this as
// the single largest avoidable cost in v1.
//
// How: each pipeline run writes `.kashara/build/<feature>/run.json` to the
// build branch with `prd_content_sha` (sha256 of the PRD file) and `decision`
// (the terminal outcome). At the start of a new run, the orchestrator
// fetches the LAST committed run.json from the build branch via the GitHub
// API. If `prd_content_sha` matches the current PRD content sha AND the
// decision is "approved", the new run is skipped.
//
// Bypass: SDLC_FORCE_RERUN=1.

import { getEnv } from './env.js';
import { getInstallationToken } from './github-app.js';
import { log } from './logger.js';

export interface PreviousRunJson {
  prdContentSha?: string | null;
  decision?: string | null;
  shippedAt?: string | null;
  /** Free-form: raw JSON for logging. */
  raw: unknown;
}

export interface IdempotencyCheckResult {
  /** True when the current run can be skipped. */
  shouldSkip: boolean;
  /** Reason text suitable for logs + step summary. */
  reason: string;
  /** The previous run.json that was found, if any. */
  previous: PreviousRunJson | null;
}

function forceRerunEnabled(): boolean {
  const raw = process.env.SDLC_FORCE_RERUN;
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return lower === '1' || lower === 'true';
}

/**
 * Fetch run.json from the build branch via the GitHub API. Returns null when
 * the file does not exist (branch missing, first run, etc.) or any other
 * fetch failure.
 */
export async function fetchPreviousRunJson(params: {
  feature: string;
  buildBranch: string;
}): Promise<PreviousRunJson | null> {
  const env = getEnv();
  const token = await getInstallationToken();
  const url =
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/` +
    encodeURI(`.kashara/build/${params.feature}/run.json`) +
    `?ref=${encodeURIComponent(params.buildBranch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'kashara-orchestrator',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    log.warn('Idempotency: GitHub contents fetch failed', {
      status: res.status,
      url,
    });
    return null;
  }
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content) return null;
  const text = Buffer.from(body.content, (body.encoding ?? 'base64') as BufferEncoding).toString(
    'utf-8',
  );
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    log.warn('Idempotency: run.json parse failed; treating as missing');
    return null;
  }
  return {
    prdContentSha:
      typeof parsed.prd_content_sha === 'string' ? (parsed.prd_content_sha as string) : null,
    decision: typeof parsed.decision === 'string' ? (parsed.decision as string) : null,
    shippedAt: typeof parsed.shipped_at === 'string' ? (parsed.shipped_at as string) : null,
    raw: parsed,
  };
}

export async function checkIdempotency(params: {
  feature: string;
  buildBranch: string;
  prdContentSha: string;
}): Promise<IdempotencyCheckResult> {
  if (forceRerunEnabled()) {
    return {
      shouldSkip: false,
      reason: 'SDLC_FORCE_RERUN is set; bypassing idempotency check',
      previous: null,
    };
  }
  const previous = await fetchPreviousRunJson({
    feature: params.feature,
    buildBranch: params.buildBranch,
  });
  if (!previous) {
    return {
      shouldSkip: false,
      reason: 'No prior run.json on build branch; first run for this feature or branch was deleted',
      previous: null,
    };
  }
  if (previous.decision !== 'approved') {
    return {
      shouldSkip: false,
      reason: `Prior run.json decision was "${previous.decision ?? 'unknown'}", not "approved"; running fresh`,
      previous,
    };
  }
  if (previous.prdContentSha !== params.prdContentSha) {
    return {
      shouldSkip: false,
      reason: `PRD content changed since the last approved run (${previous.prdContentSha?.slice(0, 12)} -> ${params.prdContentSha.slice(0, 12)})`,
      previous,
    };
  }
  return {
    shouldSkip: true,
    reason: `Same PRD content (sha ${params.prdContentSha.slice(0, 12)}) was already approved on this branch${previous.shippedAt ? ` at ${previous.shippedAt}` : ''}`,
    previous,
  };
}
