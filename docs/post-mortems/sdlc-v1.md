# Post-mortem: SDLC pipeline v1

**Build window**: May 23 to May 25, 2026 (3 active sessions)
**Author**: Amar Chavda
**Status**: Pipeline shipped. First real feature pending.

---

## What we built

A 4-agent AI software delivery pipeline that turns a one-page PRD into a reviewed pull request.

| Phase | Scope | Status |
|---|---|---|
| A | Supabase + GitHub App + 6 org secrets | Shipped |
| B | Skeleton orchestrator and reusable workflow | Shipped |
| C | Planner agent | Shipped |
| D | Coder + Tester + retry loop | Shipped |
| E | Reviewer + PR state handling | Shipped |
| F1 | Supabase agent_runs writer + payload storage | Shipped |
| F2 | PostHog event emission | Shipped |
| F3 | Budget cron + monthly kill switch | Shipped |
| G1 | Cost regression test | Shipped |
| G2 | Failure injection tests (7 scenarios) | Shipped |
| G3 | Runbook | Shipped |
| G4 | Cross-product validation (Tax + Onboard) | Shipped + verified |
| G5 | Dry-run mode (61 sec, $0 cost) | Shipped |
| G6 | PostHog dashboard | Pending real F2 events |

24 pull requests merged. 3 product repos covered. End-to-end cycle proven on Pulse, Tax, and Onboard.

---

## Headline numbers

| Metric | Value |
|---|---|
| Total PRs to ship v1 | 24 |
| Real pipeline runs during build | ~12 |
| Total API spend during build | ~$15 |
| Phase D first end-to-end run cost | $14.27 (worst-case, before optimizations) |
| Phase C planner run cost | $1.58 (typical) |
| Dry-run cycle time | 61 seconds for $0 |
| Speedup of dry-run vs real run | ~13x |
| Active build time | ~3 days, non-continuous |

---

## What went better than expected

**1. Prompt caching paid off immediately.**
Phase C runs were ~$1.58 each because the planner's input was 90% cache-readable across agents. Without caching, full pipeline runs would be $8-15 instead of $3-5. This wasn't predicted in the design doc, it was discovered after the first run.

**2. The planner caught a real PRD/code mismatch on its first run.**
The Pulse auth PRD referenced a `packages/` monorepo structure that doesn't exist in Pulse (single Next.js app). The planner flagged the mismatch and adapted the plan to real Pulse paths instead of inventing files. That's the right behavior for a senior engineer reading a half-baked spec, and it surfaced naturally without being prompted.

**3. The retry loop never triggered in real runs.**
Phase D's coder/tester loop has a max 3 retry budget. Across multiple smoke tests, the coder hit the plan correctly on the first attempt every time. Either Opus 4.7 is more capable than projected, or the planner outputs are precise enough that the coder doesn't need do-overs. Either way: pleasant surprise.

**4. The dry-run mode (G5) turned into a real productivity feature.**
Originally scoped as "optional, defer if tight." Built it anyway. Now we can iterate on orchestrator logic at $0 cost per run with full side effect coverage. Worth more than projected.

**5. Self-built infrastructure validated.**
Considered Managed Agents mid-build. Decision to stay self-built held up: full audit trail, full data residency control, no SOC 2 sub-processor expansion, no dependence on Anthropic infrastructure beyond the API itself.

---

## What went worse than expected

**1. API balance ran out mid-build.**
The Agent SDK $200 monthly credit doesn't start until June 15, 2026. Phase A through C ran on direct pay-per-token. Hit zero balance during Phase D, had to top up $30 to unblock. Should have been flagged in Phase A as a prerequisite, not discovered live.

**2. Slack failure alerts weren't wired into the SDLC pipeline at first.**
Phase B shipped without notification wiring. A real failed run went silent because the YAML had no `notify-failure` job. Added later as a Phase B retroactive patch. Should have been in the original Phase B scope.

**3. The kashara-pm skill assumed a monorepo.**
The skill that helps draft PRDs was built before the repo structure stabilized. When the planner caught the structural mismatch, the right move would have been to update the skill before generating more PRDs. Still pending.

**4. The Supabase URL org secret was set incorrectly.**
The original value was the Supabase Studio dashboard URL, not the project API URL. Phase C's health check returned HTML (a sign of the wrong URL) and we logged it as a "Supabase query returned error" warning, not a real failure. The bug surfaced in Phase F when actual writes were attempted. Easy fix once diagnosed, harder to find.

**5. Tool count bloat in MCP context.**
The kashara-mcp server loads 6 tool definitions per turn (~18K tokens). When combined with the Claude Code interactive quota burn, this contributed to the API balance running dry. Worth optimizing eventually but not urgent.

---

## What surprised us

**1. How much of "production hardening" was already done before Phase G.**
The denylist, timeouts, retry caps, audit log, and best-effort observability all landed in Phases C-F. Phase G's actual scope was thinner than expected. The hardening work was front-loaded into the earlier phases without us realizing it.

**2. How clean the handoff to Claude Code was once the design doc existed.**
The 714-line design doc was the single biggest leverage point in the build. Once it was written, Claude Code could implement entire phases autonomously with minimal back-and-forth. The doc was 70% of the actual engineering thinking.

**3. The dual-track distinction (pipeline vs platform) mattered more than expected.**
Easy to conflate "building the factory" with "building the products." Explicit separation kept Phase G focused on factory hardening rather than drifting into product features. Worth memorializing as a discipline going forward.

**4. Cross-product validation (G4) was nearly free.**
Adding Tax and Onboard to the pipeline took ~2 hours and $2-4 of token cost. Lower friction than projected. The placeholder PRD pattern (deliberately empty acceptance criteria) tested the "do nothing" path well.

**5. The pipeline is genuinely product-agnostic.**
Validated on three repos with three different file structures. The orchestrator makes no assumptions about repo layout beyond `docs/product/<product>/<feature>.md` and `.github/workflows/sdlc.yml`. That's a real win for future products.

---

## What we would do differently

**1. Write the design doc earlier, in less detail at first.**
The design doc came after Phase 0 deliverables. If it had come first (even at half the detail), Phases A-C would have shipped faster. Lesson: spec before scaffold, even if the spec is rough.

**2. Wire Slack alerts in Phase B, not as a retro patch.**
Notification infrastructure should ship with the first runnable version of any pipeline. Silent failures are the worst kind during early development.

**3. Validate Supabase connectivity end-to-end before declaring Phase A done.**
Phase A's checklist had "Supabase + bucket provisioned" but no actual write smoke test. A 10-line test would have caught the wrong URL value 2 sessions earlier.

**4. Pre-claim the API credit and verify funding source explicitly in Phase A.**
Should have been "API credit verified, balance topped up, auto-reload configured" as a Phase A deliverable. Found this gap the hard way.

**5. Build the dry-run mode (G5) in Phase B, not G.**
$0 iteration cost would have saved real money during Phase C-E development. Easy to imagine in retrospect.

**6. Set spend alerts on day 1.**
Auto-reload with cap + 3 spend alerts is a 5-minute task that prevents real outages. Should be the very first thing after creating an API key, before any code runs.

---

## What we learned about working with AI engineering

**1. Claude Code is genuinely autonomous within a clear spec.**
The 24 PRs were largely written by Claude Code with minimal human steering. Quality was high. The pattern of "design doc + handoff prompt + go" worked end-to-end.

**2. Chat is better than CLI for design decisions; CLI is better than chat for implementation.**
The right division of labor emerged organically: chat for "should we do X or Y," CLI for "implement what we decided."

**3. Token economics are non-trivial.**
Five sources of token spend: chat interactive, Claude Code interactive, pipeline API calls, MCP context bloat, prompt caching variance. Worth tracking all five separately.

**4. Verification is non-optional with AI engineering.**
Two real bugs (Supabase URL wrong, Slack alerts missing) would have shipped to production without explicit smoke tests. Trust the work but verify each phase end-to-end.

**5. The cost of being too cautious is real.**
Each "let me think about this more" round delayed shipping by hours. The pipeline's existence value compounds; every day without it is a day of slower feature shipping. Bias toward action paid off.

---

## What we're carrying into v2

| Item | Why |
|---|---|
| Pre-claim API credit verification | Phase A prerequisite, not discovery |
| Slack alerts wired with first runnable version | Phase B scope, not retroactive |
| End-to-end smoke test per phase | Catch wrong URLs, missing secrets, etc. |
| Dry-run mode earlier in build | $0 iteration during dev |
| Spend alerts configured before first API call | 5 minute task, prevents real outages |
| Design doc before scaffold | Even rough spec beats no spec |
| Update kashara-pm skill before more PRDs | Avoid repeating the monorepo assumption |
| OAuth 2.1 on kashara-mcp before scaling | Unlocks claude.ai web access |

---

## What's next

**Immediate: first real feature through the pipeline.**

The pipeline is hot. Pulse `auth.md` PRD is already written. Next step is pushing it as a real feature, watching the pipeline produce real code, reviewing the PR carefully (this is the first time AI writes Pulse code we plan to keep), and merging.

That's the real validation of v1.

**After that:**

1. Build G6 (PostHog dashboard) once F2 events have flowed for a few real runs
2. Update kashara-pm skill to match the real repo structure
3. Ship Pulse teams (next PRD already exists)
4. Slack approval gate (defer until felt the lack of it)
5. OAuth 2.1 on kashara-mcp (unlock claude.ai web)
6. First Managed Agent experiment: UAE regulatory monitor (internal, no customer data)

---

## Acknowledgments

The pipeline was built in 3 active sessions across May 23-25, 2026. Claude wrote most of it. Amar designed it, decided the contentious parts, reviewed every PR, and kept the budget under control.

What worked: incremental PRs, brutal honesty about scope, explicit handoff documents, and not letting "good" become the enemy of "shipping."

What's true now that wasn't true 3 days ago: one founder can run a 3-product engineering team. The factory is real.

---

## Related documents

| Doc | Where |
|---|---|
| Design specification | `docs/sdlc-pipeline-design.md` |
| Pipeline explainer (with diagrams) | `docs/sdlc-pipeline-explained.md` |
| Phase E handoff prompt | `docs/handoffs/phase-e-handoff.md` |
| Phase F handoff prompt | `docs/handoffs/phase-f-handoff.md` |
| Phase G handoff prompt | `docs/handoffs/phase-g-handoff.md` |
| Runbook | `docs/sdlc-runbook.md` (shipped in G3) |
| Presentation deck | `docs/decks/sdlc-pipeline-v1.pptx` |
