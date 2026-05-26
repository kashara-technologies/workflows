# Phase F handoff , Observability wiring

**Spec:** `docs/sdlc-pipeline-design.md` section 7 (Observability), section 9 (Cost), schemas defined in section 7.

## State of the pipeline

- Phases A through E complete
- Pipeline runs 4 agents end-to-end, produces 5 artifacts, opens PRs with labels and comments
- No telemetry yet beyond GH Actions logs and PR comments

## Phase F scope

### 1. Supabase agent_runs table writes

Table already exists (created in Phase A). Schema in design section 7. Insert one row per agent invocation including retries.

- Service role key already in env as `SUPABASE_SERVICE_KEY`
- URL in env as `SUPABASE_URL`
- Client wrapper already exists at `scripts/sdlc/lib/supabase.ts`
- Schema columns to fill on every insert:
  - `pipeline_run_id` (UUID, same across all agents in one pipeline run)
  - `feature_path`, `product`, `agent`, `retry_count`, `model`
  - `started_at`, `finished_at`, `status`
  - `input_tokens`, `output_tokens`, `cached_input_tokens`
  - `cost_usd` (computed from token counts using current Opus 4.7 pricing)
  - `prompt_hash` (SHA256 of the system prompt that ran; first 16 chars)
  - `input_payload_path`, `output_payload_path` (Supabase Storage paths, see step 2)
  - `error_message` (null on success)

### 2. Payload uploads to Supabase Storage

Bucket already exists (created in Phase A): `agent-payloads`. Policies allow service_role insert.

- For each agent run, upload two JSON files:
  - `{pipeline_run_id}/{agent}/{retry_count}/input.json` , the full input sent to Claude (system prompt + messages + tools)
  - `{pipeline_run_id}/{agent}/{retry_count}/output.json` , the full response from Claude including tool calls
- Write the storage paths into the agent_runs row
- 5 MB per file limit (already set on the bucket); truncate or warn if exceeded

### 3. PostHog events

PostHog project already configured. Need a new org secret:

- `POSTHOG_API_KEY` (the project API key, starts with `phc_`)
- `POSTHOG_HOST` (use `https://eu.posthog.com`)
- Add these to org secrets BEFORE the workflow runs (orchestrator should fail-fast if missing)

Events to emit:

- `agent_run_completed` per agent, properties:
  - `pipeline_run_id`, `agent`, `product`, `feature`, `model`, `status`
  - `duration_ms`, `cost_usd`, `retry_count`
  - `input_tokens`, `output_tokens`, `cached_input_tokens`
- `pipeline_run_completed` once at the end of the pipeline, properties:
  - `pipeline_run_id`, `product`, `feature`
  - `outcome` (one of `approved`, `blocked`, `failed`, `timeout`)
  - `total_cost_usd`, `total_duration_ms`, `agent_count`, `total_retries`

Super-property: `product` , should be tagged on every event so PostHog dashboards can filter by Pulse/Tax/Onboard.

Use the PostHog Node SDK (`posthog-node`). Add to `package.json`.

### 4. Monthly budget cron

Per design section 9, run nightly. Suggest:

- New workflow file `.github/workflows/budget-alert.yml` in workflows repo
- Schedule: `0 2 * * *` (02:00 UTC daily)
- Query Supabase for cumulative `cost_usd` in the current calendar month from `agent_runs`
- If >= 80% of $200, post to Slack `#alerts-warning` with current spend + projection
- If >= 100%, also post to `#alerts-critical`

### 5. Audit log: already exists from Phase D

Confirm the `99-audit.log` writer from Phase D writes denied calls correctly. No new work, just verify.

### 6. Cost calculation

Opus 4.7 pricing as of 2026-05:

| Token type | $ per million tokens |
|---|---|
| Input (uncached) | $15.00 |
| Cached input read | $1.50 (90% off) |
| Cached input write | $18.75 (25% premium first time) |
| Output | $75.00 |

Compute per agent:

```
cost_usd = (uncached_input * 15
          + cached_read_input * 1.50
          + cached_write_input * 18.75
          + output * 75) / 1_000_000
```

Anthropic API response includes a `usage` object with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. Map accordingly.

## Constraints

- Don't break existing agent flow if Supabase or PostHog is temporarily unreachable. Log a warning to GH Actions logs and continue.
- All telemetry must be best-effort, not blocking
- Keep PostHog events lightweight: properties only, no payloads
- Brand rules: no em dashes in any prose (alert messages, doc strings, etc.)

## Test approach

After implementing:

1. Smoke test with a fresh PRD edit on Pulse
2. Verify in Supabase Studio that `agent_runs` table has 4 rows (one per agent) for the latest pipeline run
3. Verify Supabase Storage has 8 files (4 agents × input.json + output.json)
4. Verify PostHog Live Events view shows 5 events: 4 × `agent_run_completed` + 1 × `pipeline_run_completed`
5. Verify the budget cron workflow runs successfully (manually trigger via `workflow_dispatch`)

## When done

Confirm:
1. `pnpm typecheck` passes
2. Smoke test produces telemetry in all 3 sinks (Supabase table, Storage, PostHog)
3. Budget cron exists and runs without error
4. Pipeline still completes in roughly the same wall-clock time (telemetry shouldn't add more than ~5s overhead)

Then ping the human in chat.

## Commit pattern

Suggested split:
1. PR: Supabase agent_runs writer + cost calculator
2. PR: Payload upload to Supabase Storage
3. PR: PostHog event emission + add POSTHOG_API_KEY org secret instructions
4. PR: Budget cron workflow

## New org secrets needed

The human will need to add these to GitHub before Phase F can run. List them in the first PR's description so they don't get missed:

- `POSTHOG_API_KEY` (phc_... project key from posthog.com)

`POSTHOG_HOST` can be hardcoded to `https://eu.posthog.com` or set as a secret if preferred.

## Cost expectation

Adding telemetry shouldn't add to the Anthropic API cost. The PostHog and Supabase overhead per pipeline run is a fraction of a cent.

Total per pipeline run: same as Phase E (~$3-5 cached).
