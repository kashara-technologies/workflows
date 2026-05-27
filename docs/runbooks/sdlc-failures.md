# Runbook: SDLC pipeline failures

**Audience:** on-call engineer triaging a pipeline failure.
**Source of truth for design:** `docs/sdlc-pipeline-design.md`.

This runbook is procedural. Use it as a checklist when a Slack alert fires or a build PR is stuck.

## How to read a failed pipeline run

1. Open the Slack alert. It links to the GitHub Actions run.
2. Open the GitHub Actions run page. The job that failed is the one with a red X.
3. Open the build PR linked in the most recent comment on the PR. The PR title is `[build] <feature>`. The PR description carries the terminal state and reviewer note (if any).
4. Open the build branch on the product repo, e.g. <https://github.com/kashara-technologies/pulse/tree/build/auth/.kashara/build/auth>.
5. Read artifacts in this order: `99-audit.log`, `03-test-results.md`, `02-summary.md`, `04-review.md`, `01-plan.md`. Stop as soon as you have the root cause.

The active label on the PR tells you which stage failed:

| Label | Stage that failed |
|---|---|
| `build:planning` | Planner died before writing the plan. Check the orchestrator step log; usually an Anthropic API error or App auth issue. |
| `build:coding` | Coder is running or just finished. Look at `02-summary.md` and `99-audit.log`. If retry comment present, see test results. |
| `build:testing` | Tester ran. Check `03-test-results.md` for the FAIL reason and the failing check's stdout. |
| `build:reviewing` | Reviewer is running. Rare to land here; PR will move on. |
| `build:approved` | Pipeline succeeded. Nothing to triage. |
| `build:blocked` | Reviewer BLOCKed. Read `04-review.md` for the rationale. |
| `build:failed` | Pipeline crashed or retries exhausted. `99-audit.log` is the first place to look. |

## Which artifact to check first

| Symptom | Artifact |
|---|---|
| Anthropic API error (4xx / 5xx) | Orchestrator step log on GitHub Actions, not an artifact. |
| Denylist refusal | `99-audit.log`, search for `shell-denied`. |
| Tests failed after retries | `03-test-results.md`, "Failures" section. |
| Build broken (tsc / lint / pnpm build) | `03-test-results.md`, "Checks run" section. |
| Reviewer BLOCK | `04-review.md`, "Blocking concerns" section. |
| Cost spike | `agent_runs` table in Supabase, sum cost_usd by pipeline_run_id. |
| Pipeline hung | GitHub Actions step log; look for the 60-minute timeout. |
| App push 403 | Orchestrator step log; the preflight from Phase C prints the App token's permissions and selected repositories. |
| Supabase write failures | Orchestrator log, search for `Recorded-agent side-effect failed`. Best-effort path; pipeline kept running. |

## How to retrigger after fixing

The pipeline runs on `push` to `main` under `docs/product/<product>/<feature>.md`. To rerun the pipeline against the same PRD:

1. Commit a no-op edit. The convention is appending an HTML comment with a timestamp:

   ```bash
   printf '\n<!-- sdlc-trigger: %s -->\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     >> docs/product/<product>/<feature>.md
   git commit -am "chore: retrigger SDLC for <feature>"
   git push
   ```

2. The existing build PR force-updates with the new run. Labels and comments reset.

If you cannot push (e.g. the PRD is in a protected branch), use the workflow_dispatch trigger from the GitHub Actions UI for the product repo's `sdlc.yml`. Pass `PRD_PATH` as input.

## How to override and merge a build:blocked PR manually

The reviewer BLOCK label is advisory, not enforcing. To merge anyway:

1. Read `04-review.md` end to end. Confirm you understand the blocking concerns.
2. Decide on each concern: accept, fix, or defer with a tracked follow-up issue.
3. If accepting, comment on the PR with the rationale: "Accepting BLOCK reasons 1, 2: <why>. Filed <issue link> for #3."
4. Convert the PR back to ready-for-review manually: GitHub PR menu, "Ready for review".
5. Merge.

Do not edit `04-review.md` to remove the BLOCK. The artifact is the historical record. Document the override in a PR comment.

## How to check telemetry in Supabase and PostHog

### Supabase

Project ref: `czqvunsqhriwqnmwnneg`. Service role key is in the org secret `SUPABASE_SERVICE_KEY`; use the dashboard for ad-hoc queries instead of pasting it locally.

Recent failures in a feature:

```sql
select agent, status, retry_count, cost_usd, error_message, started_at
from agent_runs
where feature_path like '%auth.md'
order by started_at desc
limit 20;
```

Cost roll-up for the current calendar month:

```sql
select date_trunc('day', started_at) as day,
       sum(cost_usd)::numeric(10,2) as usd
from agent_runs
where started_at >= date_trunc('month', now() at time zone 'UTC')
group by 1
order by 1;
```

Payload object for a specific agent invocation (input + output JSON):

1. From the table, copy `input_payload_path` or `output_payload_path`.
2. Storage, `agent-payloads` bucket. Path format: `<YYYY-MM-DD>/<pipeline_run_id>/<agent>-<retry>-<kind>.json`.

### PostHog (EU instance)

Two event types:

* `agent_run_completed`: one per agent invocation. Properties: `pipeline_run_id`, `agent`, `product`, `feature`, `model`, `status`, `duration_ms`, `cost_usd`, `retry_count`.
* `pipeline_run_completed`: one per pipeline. Properties: `pipeline_run_id`, `product`, `feature`, `outcome` (`approved | blocked | failed`), `total_cost_usd`, `total_duration_ms`, `agent_count`, `retries_used`.

Dashboard link: TBD after G6 lands.

## How to clear stuck pipelines (manual workflow dispatch)

GitHub Actions does not always cancel a stuck pipeline cleanly. Symptoms:

* PR is in `build:coding` for over an hour.
* GitHub Actions shows the job is still running but no new log lines for many minutes.

Steps:

1. Cancel the run: GitHub Actions, the run page, "Cancel run". This stops the runner.
2. Confirm the build branch and PR are in a clean state. If the PR is still in draft and labeled `build:coding`, leave it; the next trigger overwrites.
3. To force a fresh start, delete the build branch (the orchestrator creates it again from main on the next run):

   ```bash
   gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/build/<feature>
   gh pr close <pr-number> -d
   ```

   The next push to the PRD reopens a new PR.
4. If many runs are stuck across products, check the org-level GitHub Actions usage page for a runner outage advisory.

## Common failure patterns and fixes

### Coder retries exhausted (Slack `#alerts-critical`)

Marker file: `$GITHUB_WORKSPACE/.coder-retries-exhausted`.
Cause: tester FAILed three coder retries in a row.
Fix:

1. Read `03-test-results.md` from the latest run. Identify the failing check (typecheck, unit test, build).
2. Decide whether the PRD itself is buggy, the plan is wrong, or the coder is looping on a tractable but tricky bug.
3. Edit the PRD to clarify, or close the build PR and reopen with a manual fix. The pipeline does not retry past the budget.

### Budget kill switch tripped (Slack `#alerts-critical`)

Marker file: `$GITHUB_WORKSPACE/.budget-kill-switch-tripped`.
Cause: org/repo variable `SDLC_MONTHLY_KILL_SWITCH_USD` is set and current month spend exceeded it.
Fix:

1. Confirm the spend in Supabase: `select sum(cost_usd) from agent_runs where started_at >= date_trunc('month', now() at time zone 'UTC');`
2. Either raise the variable or wait for the next calendar month.
3. The kill switch only blocks new runs; in-flight runs on other runners continue.

### Cost regression alert (Slack `#alerts-warning`)

Marker file: `$GITHUB_WORKSPACE/.cost-regression-alert.json`.
Cause: most recent pipeline run on Pulse was outside the `[$0.40, $8.00]` envelope.
Fix:

1. Inspect the most recent pipeline run cost in Supabase, by pipeline_run_id.
2. If above the cap, look at retry counts. A passing run that needed coder retries often costs 2x to 3x more.
3. If a single agent invocation dominates, look at its input payload to see if caching is being bypassed.
4. The alert does not block PRs; treat as a signal, not a stop.

### Anthropic API 4xx (Slack `#alerts-warning`)

Most common: 400 "credit balance too low".
Fix: top up at <https://console.anthropic.com/settings/billing>, then push a fresh trigger.

Less common: 401 "invalid x-api-key". The `ANTHROPIC_API_KEY` org secret was rotated or deleted.
Fix: rotate at the Anthropic console, update the org secret.

### App push 403 "Write access to repository not granted"

Cause: kashara-orchestrator App lost write on the target repo or the installation token was for the wrong installation.
Fix:

1. Open <https://github.com/organizations/kashara-technologies/settings/installations>, find the App.
2. Repository access: confirm the target repo is in the selected list, or set to "All repositories".
3. Accept any pending permission upgrades (yellow banner).
4. Verify with `gh workflow run supabase-smoke.yml` (the preflight logs the token's permissions and selected repositories).

### actions/checkout overrides the App token (legacy)

Caught in Phase D, fixed by `lib/git.ts` swapping `http.https://github.com/.extraheader` to carry the App token. If you ever see "Write access not granted" with `contents: write` in the preflight log, recheck the extraheader swap is still there.

### Reviewer BLOCK on a real issue

Cause: the reviewer is doing its job. Read `04-review.md`.
Fix: address blockers in code (push to `build/<feature>` directly is fine), then either trigger a fresh pipeline by editing the PRD, or merge after manual review per the override flow above.

### Pipeline runs but no Slack alert on failure

Cause: `SLACK_WEBHOOK_*` org secrets missing or wrong. The `slack-alert.yml` reusable workflow uses critical / warning / info severity, picked from markers.
Fix: confirm all three webhooks exist as org secrets, run `gh workflow run slack-test.yml` (if present), or inspect a recent run's notify-failure job for the resolved webhook URL (redacted).

## Last resort: ping the human

Slack `@amar` with:

1. PR link.
2. The label and the last orchestrator comment.
3. What you tried.

Phase G complete = SDLC v1. Anything beyond what this runbook covers is a new failure family; document it here when you find it.
