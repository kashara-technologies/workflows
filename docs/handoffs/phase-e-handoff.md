# Phase E handoff , Reviewer agent + final PR handling

**Spec:** `docs/sdlc-pipeline-design.md` sections 3.4 (Reviewer), 6 (Failure handling and PR state machine), 7 (PR labels and comments).

## State of the pipeline

- Phase A (infrastructure): complete
- Phase B (skeleton orchestrator): complete
- Phase C (planner agent): complete, produces `01-plan.md`
- Phase D (coder + tester + retry loop): complete, produces `02-summary.md`, `03-test-results.md`, `99-audit.log`, real code on `build/<feature>` branch
- Phase E (this): final agent in the pipeline plus PR-state handling

## Phase E scope

### 1. Reviewer agent

- Prompt at `prompts/agents/reviewer.md`
- Reads:
  - `docs/product/<product>/<feature>.md` (the PRD)
  - `.kashara/build/<feature>/01-plan.md`
  - `.kashara/build/<feature>/02-summary.md`
  - `.kashara/build/<feature>/03-test-results.md`
  - Full code diff vs `main` (use git diff `main...build/<feature>`)
- Writes `.kashara/build/<feature>/04-review.md`
- Model: Opus 4.7
- Capabilities: read filesystem, read git diff. No shell execution. No file writes outside `04-review.md`. No code modifications.

### 2. Review content checklist (from design section 3.4)

The reviewer must cover:

- Did the implementation cover all acceptance criteria from the PRD?
- Are there obvious bugs (off-by-one, null safety, race conditions)?
- Security concerns (secrets in code, unsafe deserialization, SQL injection patterns)
- Performance red flags (N+1 queries, unbounded loops, sync I/O in hot paths)
- Brand consistency (no em dashes in prose; code style follows repo conventions)
- Test coverage proportional to risk
- Cross-reference: PRD acceptance criteria → plan items → code files → test results

### 3. Decision

- First line of `04-review.md` is the verdict: `VERDICT: APPROVE` or `VERDICT: BLOCK`
- If BLOCK, the reviewer must include a "Why blocked" section with specific concerns

### 4. PR state handling

- On APPROVE:
  - PR opens (or updates) as ready for merge (not draft)
  - Label set to `build:approved`
  - Final PR comment posted with review summary
- On BLOCK:
  - PR opens (or updates) as draft
  - Label set to `build:blocked`
  - Final PR comment includes block reason
  - Slack alert to `#alerts-warning`

### 5. Final PR description

The orchestrator (not the reviewer) writes the PR description after the reviewer finishes. Format:

```
## Summary

<one-paragraph summary from 02-summary.md>

## Verdict

<APPROVE or BLOCK, with one-line reason>

## Artifacts

- [Plan](./.kashara/build/<feature>/01-plan.md)
- [Summary](./.kashara/build/<feature>/02-summary.md)
- [Test results](./.kashara/build/<feature>/03-test-results.md)
- [Review](./.kashara/build/<feature>/04-review.md)
- [Audit log](./.kashara/build/<feature>/99-audit.log)

## Costs

Total: $X.XX, X agent runs, X minutes
```

### 6. Failure paths

Per design section 6:

- Reviewer crashes (Anthropic API error, etc.): PR opens as draft with `build:failed` label, Slack `#alerts-warning`
- Coder exhausted 3 retries (this came from Phase D, Phase E must handle it): PR opens as draft with `build:failed` label, Slack `#alerts-critical`
- Pipeline 60-min timeout: PR opens as draft with `build:failed`, Slack `#alerts-warning`

## Constraints

- Use the same App-token push helper from Phase C
- Use the same PR label/comment helpers from Phase D
- Don't break existing agent invocation patterns; extend them
- Brand rules: no em dashes anywhere in prose
- All commits go through the `kashara-orchestrator[bot]` identity

## Test approach

After implementing, trigger a fresh pipeline run by editing `docs/product/pulse/auth.md` in the pulse repo (append an HTML comment timestamp).

Watch `gh run list --workflow=sdlc.yml --repo kashara-technologies/pulse`.

Expected outputs on the resulting PR:
- `04-review.md` exists in `.kashara/build/auth/`
- PR has either `build:approved` or `build:blocked` label
- PR description follows the format above with links to all 5 artifact files
- If BLOCK: PR is draft, Slack `#alerts-warning` received a message
- If APPROVE: PR is ready for merge (not draft)

## When done

Confirm:
1. `pnpm typecheck` passes
2. Smoke test produces all 5 artifacts (`01-plan.md` through `04-review.md` plus `99-audit.log`)
3. PR state matches the reviewer's verdict
4. Final PR description includes the cost summary

Then ping the human in chat.

## Commit pattern

Same as Phases C and D: incremental PRs per subsystem. Don't squash.

Suggested split:
1. PR: reviewer agent (prompt + agent wrapper)
2. PR: PR-state machine helpers (draft toggle, description writer)
3. PR: orchestrator wiring + failure path handling
4. PR: smoke test fixes if any surface

## Cost expectations

Reviewer is the second-most-expensive agent (Opus 4.7 on full diff + PRD + plan + summary + tests). With caching: ~$0.50-0.80 per run. Without caching (first run): ~$1.50.

A full pipeline run (all 4 agents, no retries) should now cost ~$3-5 cached, ~$8-10 uncached.
