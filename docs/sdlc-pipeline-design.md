# Kashara SDLC Pipeline , Design

**Owner:** Amar Chavda (Founder)
**Status:** Approved design, not yet implemented
**Last updated:** 2026-05-25
**Implementation:** Planned across 2-3 future sessions
**Lives at:** `kashara-technologies/workflows/docs/sdlc-pipeline-design.md`

---

## 1. Overview

Automates the path from PRD to PR. When a product manager (currently Amar) merges a feature PRD into a product repo, four AI agents take it from spec to ready-for-merge code:

```
┌──────────────────────────────────────────────────────────────────┐
│ HUMAN: writes PRD at docs/product/<product>/<feature>.md         │
│        pushes to main                                            │
└────────────────────────────┬─────────────────────────────────────┘
                             ↓
              GitHub Actions trigger (path filter)
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ PIPELINE (runs in workflows repo as reusable workflow,          │
│           executes on product repo's runner)                    │
│                                                                  │
│   Planner   →   Coder   →   Tester   →   Reviewer              │
│   Opus 4.7      Opus 4.7    Opus 4.7     Opus 4.7              │
│       ↓             ↑           ↓             ↓                 │
│   01-plan.md   (retry up to 3x) 03-tests.md  04-review.md      │
└──────────────────┬──────────────────────────────────────────────┘
                   ↓
              ┌────────────┐
              │ Open / update │
              │   PR on main  │  ← uses kashara-orchestrator App
              └────────────┘
```

Each agent runs in a fresh Claude API call (sequential file-passing, no shared conversation). All artifacts land in `.kashara/build/<feature>/` and ship in the PR alongside the code.

---

## 2. Trigger contract

### When the pipeline fires

- **Event:** push
- **Branch:** `main` only
- **Path filter:** `docs/product/**/*.md`
- **Applies to:** every product repo (pulse, tax, onboard, and any future products)

### Edit semantics

- New PRD → full pipeline run
- Existing PRD edited → full pipeline re-run from scratch (no incremental builds)
- Pipeline does not fire on docs/runbooks, docs/architecture, or any other docs/* path

### PR handling

- One PR per feature, keyed on the feature's slug (derived from PRD filename)
- Branch name: `build/<feature>` (e.g. `build/auth`, `build/teams`)
- First run: opens a new PR
- Subsequent runs: force-push to the same branch; PR auto-updates
- If prior PR was closed, a new one opens

### Out of scope for trigger v1

- PR-label-based opt-in
- Manual workflow_dispatch button (we may add later for re-runs without edits)
- Multi-PRD batched runs
- Non-PRD paths (architecture docs, runbooks, etc.)

---

## 3. Agent specifications

All agents use Claude Opus 4.7 via the Anthropic API. All agents run sequentially. All capabilities are scoped per the matrix in section 5.

### 3.1 Planner

**Role:** Read the PRD and the current repo state. Produce a concrete implementation plan.

**Input files:**
- `docs/product/<product>/<feature>.md` (the PRD)
- Repo tree (read-only via tool)
- Selected repo files the agent chooses to read

**Output file:** `.kashara/build/<feature>/01-plan.md`

**Plan must cover:**
- Files to create (with full paths and one-line purpose each)
- Files to modify (with paths and what changes)
- New dependencies to install (with versions where pinned)
- Test strategy (what tests to write, what existing tests should still pass)
- Mapping from PRD acceptance criteria to implementation steps
- Risks identified during planning
- Out-of-scope clarifications (anything in the PRD the planner cannot deliver)

**Capabilities:**
- Read filesystem (full repo)
- Web search (for library docs, API references)
- Kashara MCP (read other repo docs for cross-product context)
- No shell execution
- No file writes outside `.kashara/build/<feature>/01-plan.md`
- No git operations

**Stops when:** plan covers all PRD acceptance criteria and has no open questions, OR the planner determines it cannot proceed (writes a blocking note in the plan).

### 3.2 Coder

**Role:** Read the plan and execute it. Write code, install dependencies, commit.

**Input files:**
- `docs/product/<product>/<feature>.md`
- `.kashara/build/<feature>/01-plan.md`
- The repo at HEAD

**Output:**
- Code changes on branch `build/<feature>`
- `.kashara/build/<feature>/02-summary.md` (what was built, deviations from plan, decisions made)

**Capabilities:**
- Read filesystem
- Write filesystem (anywhere in the repo working dir)
- Shell execution (any command not in the denylist, see section 5)
- Git operations on `build/<feature>` branch
- No web search (avoid scope drift; rely on planner's research)
- No MCP access (focus on the local repo)

**Behavior:**
- Creates `build/<feature>` branch from main if absent
- Force-pushes on subsequent runs
- Commits are squashed into one or more logical commits (not one-per-file)
- Conventional Commits format for commit messages

**Stops when:** all files in the plan touched, no unresolved TODO comments left in code, summary written.

**Retry mode (called by tester):**
- Reads `03-test-results.md` plus original plan
- Makes targeted fixes only
- Updates the summary

### 3.3 Tester

**Role:** Verify the coder's output meets quality bars. Run lint, typecheck, build, tests. Decide pass or fail.

**Input files:**
- `.kashara/build/<feature>/01-plan.md` (knows what was supposed to be tested)
- `.kashara/build/<feature>/02-summary.md` (knows what was actually built)
- The repo at the coder's commit

**Output file:** `.kashara/build/<feature>/03-test-results.md`

**Capabilities:**
- Read filesystem
- Shell execution (any command not in the denylist)
- Write only to `03-test-results.md`
- No code modifications
- No git operations

**Behavior:**
- Runs the project's standard checks: `pnpm install`, `pnpm exec tsc --noEmit`, `pnpm lint` (if exists), `pnpm test` (if exists), `pnpm build`
- Captures stdout/stderr per check
- Decides pass/fail per acceptance criterion in the plan
- If failing, writes a structured fix request (which test, what failed, what to change)

**Stops when:** all checks pass OR the tester writes a fix request.

### 3.4 Reviewer

**Role:** Final quality gate. Read everything, decide whether the PR is mergeable.

**Input files:**
- `docs/product/<product>/<feature>.md` (PRD)
- `.kashara/build/<feature>/01-plan.md`
- `.kashara/build/<feature>/02-summary.md`
- `.kashara/build/<feature>/03-test-results.md`
- The full code diff vs main

**Output file:** `.kashara/build/<feature>/04-review.md`

**Capabilities:**
- Read filesystem
- Read git diff
- No shell execution
- Write only to `04-review.md`
- No code modifications

**Review covers:**
- Did the implementation cover all acceptance criteria? (cross-reference PRD)
- Are there obvious bugs (off-by-one, null safety, race conditions)?
- Security concerns (secrets in code, unsafe deserialization, SQL injection patterns)
- Performance red flags (N+1 queries, unbounded loops, sync I/O in hot paths)
- Brand consistency (per CONTEXT in kashara-pm skill: no em dashes, code style, etc.)
- Test coverage proportional to risk

**Decision:** `APPROVE` or `BLOCK`. Written at the top of `04-review.md`.

- `APPROVE` → PR opens as ready for merge
- `BLOCK` → PR opens as draft with the block reason in the PR description

---

## 4. File contract

### Directory layout

```
.kashara/
  build/
    <feature>/                       # one dir per PRD
      prd.snapshot.md                # copy of PRD at pipeline-run time
      01-plan.md                     # planner output
      02-summary.md                  # coder output (code lives in git)
      03-test-results.md             # tester output
      04-review.md                   # reviewer output
      99-audit.log                   # every shell call across all agents
      run.json                       # pipeline metadata (run id, timing, retries, costs)
```

### `run.json` schema

```json
{
  "run_id": "uuid",
  "feature": "auth",
  "product": "pulse",
  "prd_path": "docs/product/pulse/auth.md",
  "prd_sha": "git sha of the PRD at pipeline start",
  "started_at": "ISO timestamp",
  "finished_at": "ISO timestamp",
  "status": "success | blocked | failed | timeout",
  "agents": [
    {
      "name": "planner",
      "started_at": "...",
      "finished_at": "...",
      "status": "success",
      "input_tokens": 18420,
      "output_tokens": 4801,
      "cached_input_tokens": 14000,
      "cost_usd": 0.42,
      "retry_of": null
    }
    // ... one entry per agent invocation (coder may have up to 4 entries: 1 initial + 3 retries)
  ]
}
```

### Versioning

- File schemas above are v1. Future changes documented in a `## Changelog` section in this design doc.
- Pipeline reads its own version from a `.kashara/pipeline-version` file in the workflows repo. Mismatches log a warning but proceed.

---

## 5. Capability boundaries

### Denylist (applies to coder and tester shell access)

Any shell command containing one of these patterns is refused by the runner. The agent receives an error and must choose a different approach.

```
rm -rf
rm -fr
git push --force
git push -f
pnpm publish
npm publish
yarn publish
gh pr merge
gh pr close
gh release create
sudo
chmod 777
chown
--no-verify
--force (in destructive contexts)
> /etc/
> /usr/
> /var/
> /System/
curl ... | sh
wget ... | sh
eval $(
```

Implementation: shell calls go through an orchestrator wrapper that pattern-matches before exec. Audit log records every call (including denied ones with a `denied: true` flag).

### Timeouts

- 15 minutes per agent call (hard kill via `timeout` GNU coreutil)
- 60 minutes total pipeline runtime (the orchestrator self-kills if exceeded)
- 5 minutes per shell call (kill the shell child process)

### File write boundaries

- Agents can only write files inside the checked-out repo working directory
- Agents cannot write to `~/.ssh`, `~/.gitconfig`, `~/.npmrc`, or any path outside `$GITHUB_WORKSPACE`
- The orchestrator enforces this by validating every file_write tool call against an allowlist

### Network egress

- GitHub-hosted runners default outbound (npm registry, GitHub API, Anthropic API)
- No outbound to internal-only resources (none exist yet)
- No setting up tunnels, port forwarding, or reverse proxies

### Secrets

- Each agent receives only the env vars it needs (see section 8 for the per-agent secret map)
- Agents cannot read `~/.env`, `GITHUB_TOKEN` (orchestrator uses it, agents do not), or other workflow secrets unless explicitly passed in

### Audit log format (`99-audit.log`)

```
2026-05-25T14:23:01.123Z [coder] [shell] pnpm install --frozen-lockfile [exit=0] [duration=4.2s]
2026-05-25T14:23:05.456Z [coder] [shell] pnpm exec tsc --noEmit [exit=0] [duration=2.1s]
2026-05-25T14:23:08.789Z [coder] [shell] git add src/lib/auth.ts [exit=0] [duration=0.1s]
2026-05-25T14:23:09.012Z [coder] [shell-denied] git push --force [reason=denylist:force-push]
```

Append-only, plain text, one line per call. Final file committed to the PR.

---

## 6. Failure handling

### State machine

```
[start] → planning → coding → testing → (pass?)
                              ↓ pass
                              reviewing → (decision?)
                                            ↓ APPROVE → success → PR ready
                                            ↓ BLOCK   → blocked → PR draft
                              ↓ fail
                              coding (retry) → testing (re-evaluate)
                              ↓ failed 3 times
                              failed → PR draft with all artifacts
```

### Retry budget

- Tester → Coder retry loop: max 3 retries
- Counter resets on each new pipeline run (new PRD push)
- Retries always re-run tester after coder finishes
- Cumulative timeout still applies (60 min total)

### Slack routing

| Outcome | Channel |
|---|---|
| All 3 coder retries exhausted (test failure persists) | `#alerts-critical` |
| Reviewer BLOCKS | `#alerts-warning` |
| Pipeline timeout | `#alerts-warning` |
| Any agent crashes (Anthropic API error, network issue, code bug in orchestrator) | `#alerts-warning` |
| Cost cap breached (see section 9) | `#alerts-warning` |
| Successful run | No alert |

Routing uses the existing `kashara-technologies/workflows/.github/workflows/slack-alert.yml`.

### PR state on failure

In all failure modes, the PR opens (or updates) as **draft** with:
- Title: `[build] <feature>: <one-line summary>`
- Description: status badge, links to all 4 artifact files, summary of what failed
- Labels: `build:failed`, `build:<final-stage>` (e.g. `build:tester`)
- The 4 artifact files committed even if incomplete (so the human can see what the agents did before failure)

---

## 7. Observability

### PR labels (state)

The orchestrator updates a single label as the pipeline progresses. Only one `build:*` label is active at a time on a PR.

- `build:planning`
- `build:coding`
- `build:testing`
- `build:reviewing`
- `build:approved`
- `build:blocked`
- `build:failed`

### PR comments (milestones)

The orchestrator posts a comment when each agent completes:

```
✅ **Planner complete** (Opus 4.7, 23k input / 4.8k output, $0.42, 1m 12s)
Plan: [.kashara/build/auth/01-plan.md](link)
12 files to create, 3 to modify, 4 new dependencies.
```

```
⚠️ **Coder retry 1 of 3** , tests failed
Failures: typecheck, 2 unit tests
Coder will attempt fixes.
```

Comments are append-only. A failed run leaves a comment trail showing exactly where things broke.

### Supabase `agent_runs` table

```sql
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  pipeline_run_id uuid not null,
  feature_path text not null,
  product text not null,
  agent text not null check (agent in ('planner','coder','tester','reviewer')),
  retry_count int not null default 0,
  model text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('success','failure','timeout')),
  input_tokens int,
  output_tokens int,
  cached_input_tokens int,
  cost_usd numeric(10,4),
  prompt_hash text,
  input_payload_path text,   -- e.g. s3://kashara-audit/2026-05-25/abc-123-planner-input.json
  output_payload_path text,
  error_message text,
  created_at timestamptz not null default now()
);

create index agent_runs_pipeline_run_id_idx on agent_runs (pipeline_run_id);
create index agent_runs_created_at_idx on agent_runs (created_at desc);

alter table agent_runs enable row level security;
-- RLS: append-only, no updates or deletes by the orchestrator role
```

Payloads (full input/output JSON) write to S3 or Supabase Storage. The table holds metadata + pointer.

### PostHog events

One event per agent run, lightweight:

| Event | Properties |
|---|---|
| `agent_run_completed` | `pipeline_run_id`, `agent`, `product`, `feature`, `model`, `status`, `duration_ms`, `cost_usd`, `retry_count` |
| `pipeline_run_completed` | `pipeline_run_id`, `product`, `feature`, `outcome` (`approved`/`blocked`/`failed`), `total_cost_usd`, `total_duration_ms`, `agent_count` |

Super-property `product: pulse | tax | onboard` already attached per the marketing-site convention.

### GitHub Actions logs

Default `set -x`-style output captured. Useful for debugging the orchestrator itself (vs the agents).

### Monthly budget alert

- Source: Anthropic API usage endpoint
- Check: nightly cron in the workflows repo
- Threshold: 80% of the $200 Agent SDK credit
- Alert: post to `#alerts-warning` with current spend + projection
- Hard cap: NONE per the design decision (no per-run cost cap). If the credit is exhausted, future API calls fail; orchestrator surfaces that as a normal pipeline failure.

---

## 8. Repo and identity

### Where things live

| Component | Repo | Path |
|---|---|---|
| Pipeline YAML | `kashara-technologies/workflows` | `.github/workflows/sdlc-pipeline.yml` |
| Orchestrator scripts | `kashara-technologies/workflows` | `scripts/sdlc/*.ts` |
| Agent prompts | `kashara-technologies/workflows` | `prompts/agents/{planner,coder,tester,reviewer}.md` |
| Denylist config | `kashara-technologies/workflows` | `config/denylist.txt` |
| Design doc (this file) | `kashara-technologies/workflows` | `docs/sdlc-pipeline-design.md` |
| Per-feature artifacts | Product repo (pulse / tax / onboard) | `.kashara/build/<feature>/` |
| Generated code | Product repo | wherever the plan says |

### Caller wiring (per product)

Each product repo has a `.github/workflows/sdlc.yml`:

```yaml
name: SDLC

on:
  push:
    branches: [main]
    paths:
      - 'docs/product/**/*.md'

jobs:
  sdlc:
    uses: kashara-technologies/workflows/.github/workflows/sdlc-pipeline.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
      SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
      POSTHOG_KEY: ${{ secrets.POSTHOG_KEY }}
      POSTHOG_HOST: ${{ secrets.POSTHOG_HOST }}
      SLACK_WEBHOOK_CRITICAL: ${{ secrets.SLACK_WEBHOOK_CRITICAL }}
      SLACK_WEBHOOK_WARNING: ${{ secrets.SLACK_WEBHOOK_WARNING }}
      ORCHESTRATOR_APP_ID: ${{ secrets.ORCHESTRATOR_APP_ID }}
      ORCHESTRATOR_APP_PRIVATE_KEY: ${{ secrets.ORCHESTRATOR_APP_PRIVATE_KEY }}
      ORCHESTRATOR_APP_INSTALLATION_ID: ${{ secrets.ORCHESTRATOR_APP_INSTALLATION_ID }}
```

### GitHub App: `kashara-orchestrator`

A new GitHub App, separate from `kashara-mcp`. Reasons:
- Audit trail isolation: PRs opened by orchestrator are visually distinct from MCP-opened PRs
- Permission isolation: orchestrator needs broader write scope; MCP stays read-mostly
- Easier to revoke one without affecting the other

**Permissions:**

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write (for PR comments and labels) |
| Actions | Read (to read its own workflow context) |
| Metadata | Read |

**Installed on:** pulse, tax, onboard.

### Per-agent secret map

Limits blast radius if an agent prompt is jailbroken.

| Agent | Secrets it sees |
|---|---|
| Orchestrator (top-level) | All |
| Planner | `ANTHROPIC_API_KEY`, `KASHARA_MCP_BEARER_TOKEN` (for MCP), no GitHub creds |
| Coder | `ANTHROPIC_API_KEY` only |
| Tester | `ANTHROPIC_API_KEY` only |
| Reviewer | `ANTHROPIC_API_KEY` only |

Git/PR operations happen via the orchestrator using the GitHub App credentials, not via the agents directly.

---

## 9. Models and cost

### Model assignments

All 4 agents: **Claude Opus 4.7** via Anthropic API.

Rationale: highest quality across the board. Cost stays inside the $200/mo Agent SDK credit at projected volume.

### Prompt caching

Anthropic prompt caching enabled on:

| Cached content | Lifetime | Why |
|---|---|---|
| Agent system prompt | 5 min default, refreshed each pipeline run | Same prompt across many runs |
| PRD content | Across all 4 agents in one pipeline run | Each agent re-reads the same PRD |
| Repo file context (selected by planner) | From planner through coder/reviewer | Saves re-reading the same source files |

Implementation: each agent call structures messages with the cacheable content marked with `cache_control: { type: "ephemeral" }`.

### Projected cost

| Item | Cached | Uncached |
|---|---|---|
| One full pipeline run | ~$0.80 | ~$2.50 |
| Monthly at 50 runs | ~$40 | ~$125 |
| Monthly at 100 runs | ~$80 | ~$250 (over credit) |

Budget alert fires at 80% of $200 = $160/mo. Soft cap. No hard per-run cap.

---

## 10. Build order (implementation roadmap)

Phased so each phase delivers a testable artifact. Not all in one session.

### Phase A , Infrastructure prerequisites (1 session)

- [ ] Create Supabase project for Kashara (the actual database, not the project ID alone)
- [ ] Create `agent_runs` table + RLS policies
- [ ] Create `kashara-orchestrator` GitHub App with permissions per section 8
- [ ] Install app on pulse, tax, onboard
- [ ] Capture App ID, Installation ID, Private Key
- [ ] Get Anthropic API key from Anthropic console; add as `ANTHROPIC_API_KEY` org secret
- [ ] Add all new secrets to org-level (Supabase URL/key, orchestrator app creds)
- [ ] Decide on payload storage backend (S3 vs Supabase Storage)

### Phase B , Skeleton pipeline (1 session)

- [ ] Create `sdlc-pipeline.yml` in workflows repo (just the trigger + checkout + smoke step)
- [ ] Create `scripts/sdlc/orchestrator.ts` shell that does nothing yet
- [ ] Wire one product repo's `.github/workflows/sdlc.yml`
- [ ] Push a test PRD; confirm the pipeline triggers, runs the skeleton, exits cleanly
- [ ] Confirm Slack alert wiring still works

### Phase C , Planner agent (1 session)

- [ ] Write planner system prompt
- [ ] Implement Anthropic API client with prompt caching
- [ ] Implement file-read tool (sandboxed to repo)
- [ ] Implement web search tool wrapping
- [ ] Implement Kashara MCP tool wrapping (call our existing MCP server)
- [ ] Implement `01-plan.md` writer
- [ ] Wire planner into the orchestrator
- [ ] Test on `pulse/docs/product/pulse/auth.md`
- [ ] Iterate on prompt until plans are useful

### Phase D , Coder + Tester + retry loop (1 session)

- [ ] Coder system prompt + shell wrapper with denylist
- [ ] Tester system prompt + test runner wrapper
- [ ] Implement retry loop with max 3
- [ ] Audit log writer (`99-audit.log`)
- [ ] PR label updater
- [ ] PR comment poster
- [ ] Wire into orchestrator
- [ ] Test end-to-end on auth PRD

### Phase E , Reviewer + final PR handling (1 session)

- [ ] Reviewer system prompt
- [ ] Diff reader
- [ ] PR draft state handler (BLOCK → draft, APPROVE → ready)
- [ ] Final PR description generator
- [ ] Test end-to-end

### Phase F , Observability (1 session)

- [ ] Supabase logging wired into orchestrator
- [ ] PostHog event emission
- [ ] Monthly budget cron alert
- [ ] Payload uploader (S3 or Supabase Storage)

### Phase G , Production hardening (1 session)

- [ ] Cost regression test (run a known PRD, assert cost stays within tolerance)
- [ ] Failure injection tests (network timeout, API rate limit, denylist trigger)
- [ ] Documentation update (runbook entry for pipeline failures)
- [ ] Onboard pulse → tax → onboard (cross-product test)

**Total estimated effort: 6-7 sessions** of focused work.

---

## 11. Prerequisites

Things that must exist before pipeline runs.

| Prerequisite | Status as of design date | Where created |
|---|---|---|
| Supabase project | ❌ Not provisioned | Manual: supabase.com |
| `agent_runs` table | ❌ | SQL migration in workflows repo |
| `kashara-orchestrator` GitHub App | ❌ | github.com/organizations/kashara-technologies/settings/apps |
| Anthropic API key | ❌ | console.anthropic.com |
| `ANTHROPIC_API_KEY` org secret | ❌ | `gh secret set` |
| Orchestrator app creds as org secrets | ❌ | `gh secret set` |
| Supabase creds as org secrets | ❌ | `gh secret set` |
| Existing workflows repo CI + Slack alert | ✅ | Shipped |
| Existing kashara-mcp | ✅ | Shipped |
| Kashara observability runbook | ✅ | Shipped |
| First Pulse PRDs (auth, teams) | ✅ | Shipped |

---

## 12. Open questions deferred to implementation

Things the design doesn't lock down. Each surfaces during the corresponding build phase.

- **Payload storage backend:** Supabase Storage vs S3 vs blob in the table. Defer until Phase F.
- **Cross-product context:** when a feature in Pulse references Tax (rare but possible), how does the planner access the Tax repo? Defer; for now planner reads via Kashara MCP.
- **Concurrent pipeline runs:** if two PRDs land in the same minute, do they queue or run in parallel? Default to parallel (GH Actions handles it). Revisit if cost / runner contention becomes an issue.
- **PRD style enforcement:** the `kashara-pm` skill defines PRD format. Should the pipeline reject PRDs that don't validate? Defer; for now planner copes with malformed PRDs.
- **Prompt versioning:** every prompt change is a behavior change. Need a way to pin a pipeline run to a prompt version. Defer; for now `prompt_hash` in agent_runs captures it post-hoc.
- **Cost alerting cadence:** nightly cron vs real-time. Nightly is simpler; real-time is safer. Defer.
- **Multi-product features:** features that touch pulse + tax simultaneously. Out of scope for v1. Plan to revisit when this comes up in practice.

---

## 13. Non-goals for v1

Explicit list of things the pipeline does NOT do:

- Generate PRDs (PRDs come from humans via the `kashara-pm` skill)
- Merge PRs (human approval required, always)
- Modify existing code outside the PRD's stated scope
- Deploy code (CI handles deploys post-merge, separately)
- Refactor existing code unprovoked
- Cross-repo changes (one product per pipeline run)
- Database migrations beyond what the plan explicitly approves
- Modify production secrets, API keys, or configuration
- Send messages on behalf of the user (email, Slack DMs, etc.)
- Update PRDs (the PRD is read-only input)

---

## 14. Glossary

| Term | Meaning |
|---|---|
| PRD | Product Requirements Document. Markdown file under `docs/product/<product>/<feature>.md` defining what to build. |
| Feature | One PRD's worth of scope. Named by filename (e.g., "auth", "teams"). |
| Pipeline run | One complete execution of all 4 agents triggered by one PRD push. |
| Agent run | One agent's invocation. Multiple agent runs per pipeline run (especially with coder retries). |
| Orchestrator | The Node/TS code in the workflows repo that drives the agents, applies guardrails, opens PRs. |
| Build branch | `build/<feature>` , where the coder writes code. |
| Artifact | A file in `.kashara/build/<feature>/`. Outlives the pipeline run; committed to the PR. |

---

## 15. Changelog

| Date | Change | Notes |
|---|---|---|
| 2026-05-25 | Initial design | Approved by Amar; pending implementation |
