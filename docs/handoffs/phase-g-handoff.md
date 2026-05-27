# Phase G handoff , Production hardening

**Spec:** `docs/sdlc-pipeline-design.md` section 10 (Phase G items).

## State of the pipeline

- Phases A through F complete
- Pipeline produces 5 artifacts, opens PRs with labels and comments, writes telemetry to Supabase + PostHog
- Budget cron working
- Currently tested only against Pulse with one PRD (`auth.md`)

## Phase G scope

Production hardening: stop bugs before they reach the live pipeline.

### 1. Cost regression test

A test that prevents accidental cost blowups (e.g., someone removes prompt caching, a new agent gets added with bad token economics).

- Create `scripts/sdlc/tests/cost-regression.ts`
- Define a baseline cost envelope per pipeline run (e.g., min $0.40, max $8.00 with retries)
- After every successful smoke test, query the most recent `pipeline_run_completed` cost from Supabase
- Assert it falls within the envelope
- Wire into CI: a GitHub Actions check that runs nightly against the most recent pipeline run on Pulse
- Fail loudly with a Slack `#alerts-warning` if out of bounds

### 2. Failure injection tests

Per design section 6, the pipeline has multiple failure paths. Verify each one actually triggers correctly.

Create `scripts/sdlc/tests/failure-injection.ts`. Each test mocks a specific failure and asserts the pipeline behaves correctly:

| Failure | Expected behavior |
|---|---|
| Anthropic API returns 500 | Agent retries 3 times, then pipeline marks `build:failed`, Slack `#alerts-warning` |
| Anthropic API returns 429 (rate limit) | Agent waits and retries; eventually succeeds or gives up after timeout |
| Denylist command attempted (`rm -rf /`) | Shell call refused, audit log records `shell-denied`, agent gets error and tries different approach |
| `pnpm install` times out | Tester reports timeout, no infinite hang |
| Coder produces 3 failing test rounds | Retry loop exhausts, PR opens as draft with `build:failed`, Slack `#alerts-critical` |
| Network unreachable to Supabase | Pipeline continues (telemetry is best-effort), GH Actions logs the warning |
| PR creation fails (App token expired) | Pipeline retries token refresh; on hard failure, surfaces via Slack `#alerts-warning` |

These don't have to be full end-to-end runs. Mock the failing dependency at the right boundary.

### 3. Runbook entry

Update Pulse's existing `docs/runbook-observability.md` (or create a new one in workflows repo) with a section called "SDLC pipeline failures":

- How to read a failed pipeline run
- Which artifacts to check first (`99-audit.log`, then `03-test-results.md`, then `02-summary.md`)
- How to retrigger after fixing
- How to override and merge a `build:blocked` PR manually
- How to check telemetry in Supabase + PostHog
- How to clear stuck pipelines (manual workflow dispatch)
- Common failure patterns and fixes

### 4. Cross-product test

So far the pipeline only ran against Pulse. Verify it works on Tax and Onboard too.

- Add a placeholder PRD to Tax: `docs/product/tax/setup.md` (minimal, just enough to trigger the pipeline)
- Add the SDLC caller workflow to Tax: copy `.github/workflows/sdlc.yml` from Pulse to Tax
- Same for Onboard

Don't actually run a full pipeline against Tax or Onboard yet (that would create real code we don't want). Instead, push a tiny PRD edit and verify:
- Pipeline triggers on Tax/Onboard repos
- Planner agent reads the PRD and writes `01-plan.md`
- Coder agent starts but the placeholder PRD has no acceptance criteria, so the plan should say "nothing to build" and the coder should exit cleanly

Result: confirms the pipeline is product-agnostic.

### 5. Optional: dry-run mode

Useful for testing without spending tokens. Add a CLI flag or env var (`SDLC_DRY_RUN=1`) that:

- Replays a cached response per agent from a fixtures directory
- Doesn't call Anthropic API at all
- Useful for: testing failure injection (#2), iterating on prompts, demo/training

Defer if scope tight; not blocking.

### 6. Observability dashboard

Build a simple PostHog dashboard from the events emitted in Phase F:

- Pipeline runs per day by product
- Average cost per pipeline run, trending
- Success rate (approved / total)
- Mean time from trigger to PR open
- Token usage by agent

Pin the dashboard URL in the runbook.

## Constraints

- Don't break Phase E pipeline flow with the new tests; gate them behind explicit triggers (nightly cron or `workflow_dispatch`)
- Cost regression should NOT block PR merges; it's an alert only
- Failure injection tests must not actually trigger Slack alerts (route them to a `#alerts-test` channel or use a feature flag)
- Brand rules: no em dashes anywhere

## Test approach

For each piece:
1. Cost regression: run nightly against last 7 days of pipeline runs, verify all within envelope
2. Failure injection: each test scenario passes its own assertions
3. Runbook: peer-review (read it aloud or have someone else read it) for missing steps
4. Cross-product: Tax and Onboard pipelines trigger and produce `01-plan.md` without error
5. Dashboard: visible at posthog.com and shows real data

## When done

Confirm:
1. All new tests pass in CI
2. Cross-product test confirms Tax + Onboard pipelines trigger
3. Runbook is accurate (verified by following it end-to-end through one failure scenario)
4. Cost regression test alert wiring works (artificially fail it once to confirm Slack receives the alert)

Then ping the human in chat with a summary.

## Commit pattern

Suggested split:
1. PR: Cost regression test + nightly workflow
2. PR: Failure injection tests
3. PR: Runbook entry (in workflows or pulse repo, depending on preference)
4. PR: Tax + Onboard caller workflows
5. PR (optional): Dry-run mode

## What's NOT in Phase G

Out of scope to keep this finishable:
- Multi-product features (one PRD touching pulse + tax)
- SAML SSO or other enterprise infrastructure
- Agent prompt versioning beyond `prompt_hash`
- Concurrent pipeline run management beyond GH's default
- Per-tenant cost attribution
- Production-grade load testing (>100 pipelines/day)

These can be follow-up phases if needed.

## What "production-ready" means after Phase G

After this phase:
- Pipeline is observably reliable: you can see if it's healthy or broken from PostHog
- Cost regression detection catches accidental token-burning regressions
- Each known failure path has a tested, alertable response
- Runbook exists for on-call
- All 3 products (Pulse, Tax, Onboard) can be served by the pipeline

Phase G complete = end of SDLC pipeline v1.

## Sessions after Phase G

Things that come up next (not part of Phase G):
- Add OAuth 2.1 to Kashara MCP server (separate concern from SDLC)
- Update kashara-pm skill for actual repo structure
- Build first real Pulse features through the pipeline (auth, then teams)
- Compliance freeze decisions (ComplyAdvantage acceptance, etc.)
