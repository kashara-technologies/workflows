# Kashara — Reusable GitHub Actions Workflows

Shared CI/CD workflows used across `pulse`, `tax`, `onboard`, and future Kashara repos.

## Available workflows

| Workflow | Path | Purpose |
|---|---|---|
| CI | `.github/workflows/ci.yml` | Install, typecheck, lint, build a Next.js app |
| Slack Alert | `.github/workflows/slack-alert.yml` | Post failures to Slack with severity routing |

## Usage

In a consumer repo, create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    uses: kashara-technologies/workflows/.github/workflows/ci.yml@main
    secrets: inherit

  notify-on-failure:
    needs: build
    if: failure()
    uses: kashara-technologies/workflows/.github/workflows/slack-alert.yml@main
    with:
      workflow_name: CI
      job_name: build
    secrets: inherit
```

## Slack severity routing

- Failures on `main` → `#alerts-critical`
- Failures on any other branch (PRs) → `#alerts-warning`
- Override with `severity: info | warning | critical` input

## Secrets required (org-level)

| Secret | Used by |
|---|---|
| `SENTRY_ORG`, `SENTRY_AUTH_TOKEN` | `ci.yml` (source map upload) |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | `ci.yml` (build-time env) |
| `SLACK_WEBHOOK_CRITICAL`, `SLACK_WEBHOOK_WARNING`, `SLACK_WEBHOOK_INFO` | `slack-alert.yml` |

Per-repo: `NEXT_PUBLIC_SENTRY_DSN` (DSN differs per product).

## Versioning

Consumers pin to `@main` for now. Once workflows stabilize, switch to tagged releases (`@v1`).

## SDLC Orchestrator

The `scripts/sdlc/` directory hosts the Kashara SDLC pipeline orchestrator.

Design doc: [docs/sdlc-pipeline-design.md](./docs/sdlc-pipeline-design.md)

### Local development

```bash
pnpm install
pnpm typecheck
pnpm orchestrator docs/product/pulse/auth.md
```

The orchestrator expects these env vars:

- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `ORCHESTRATOR_APP_ID`, `ORCHESTRATOR_APP_INSTALLATION_ID`, `ORCHESTRATOR_APP_PRIVATE_KEY`
- `GITHUB_WORKSPACE`, `GITHUB_REPOSITORY`, `GITHUB_SHA` (GH Actions sets these)

In CI, these come from org-level GitHub Secrets.

### Build phases

See [docs/sdlc-pipeline-design.md section 10](./docs/sdlc-pipeline-design.md). Phase B (skeleton) is complete; Phases C through G ship agent capabilities incrementally.
