#!/usr/bin/env bash
# scaffold-workflows.sh
# Creates reusable GitHub Actions workflows in the kashara-technologies/workflows repo.
# Run from the workflows repo root.
set -euo pipefail

if [[ ! -d ".git" ]]; then
  echo "ERROR: Run this from the workflows repo root (where .git lives)." >&2
  exit 1
fi

mkdir -p .github/workflows

# ────────────────────────────────────────────────────────────────────────────
# 1. slack-alert.yml — reusable workflow, posts to Slack on failure
# ────────────────────────────────────────────────────────────────────────────
cat > .github/workflows/slack-alert.yml << 'EOF'
# Reusable workflow: post a failure alert to Slack.
# Called by other workflows when a job fails.
#
# Routing:
#   - main branch failure  → SLACK_WEBHOOK_CRITICAL
#   - PR / other failure   → SLACK_WEBHOOK_WARNING

name: Slack Alert

on:
  workflow_call:
    inputs:
      job_name:
        description: "Name of the failing job"
        required: true
        type: string
      workflow_name:
        description: "Name of the calling workflow"
        required: true
        type: string
      severity:
        description: "Severity override: critical | warning | info"
        required: false
        type: string
        default: ""
    secrets:
      SLACK_WEBHOOK_CRITICAL:
        required: true
      SLACK_WEBHOOK_WARNING:
        required: true
      SLACK_WEBHOOK_INFO:
        required: true

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve severity
        id: severity
        run: |
          if [[ -n "${{ inputs.severity }}" ]]; then
            echo "level=${{ inputs.severity }}" >> $GITHUB_OUTPUT
          elif [[ "${{ github.ref }}" == "refs/heads/main" ]]; then
            echo "level=critical" >> $GITHUB_OUTPUT
          else
            echo "level=warning" >> $GITHUB_OUTPUT
          fi

      - name: Pick webhook
        id: webhook
        env:
          CRITICAL: ${{ secrets.SLACK_WEBHOOK_CRITICAL }}
          WARNING: ${{ secrets.SLACK_WEBHOOK_WARNING }}
          INFO: ${{ secrets.SLACK_WEBHOOK_INFO }}
        run: |
          case "${{ steps.severity.outputs.level }}" in
            critical) echo "url=$CRITICAL" >> $GITHUB_OUTPUT ;;
            warning)  echo "url=$WARNING"  >> $GITHUB_OUTPUT ;;
            info)     echo "url=$INFO"     >> $GITHUB_OUTPUT ;;
            *)        echo "url=$WARNING"  >> $GITHUB_OUTPUT ;;
          esac

      - name: Post to Slack
        env:
          WEBHOOK: ${{ steps.webhook.outputs.url }}
          LEVEL: ${{ steps.severity.outputs.level }}
        run: |
          ICON_MAP_critical=":rotating_light:"
          ICON_MAP_warning=":warning:"
          ICON_MAP_info=":information_source:"
          ICON_VAR="ICON_MAP_${LEVEL}"
          ICON="${!ICON_VAR}"

          COLOR_MAP_critical="#dc2626"
          COLOR_MAP_warning="#f59e0b"
          COLOR_MAP_info="#3b82f6"
          COLOR_VAR="COLOR_MAP_${LEVEL}"
          COLOR="${!COLOR_VAR}"

          RUN_URL="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"

          PAYLOAD=$(cat <<JSON
          {
            "attachments": [
              {
                "color": "${COLOR}",
                "blocks": [
                  {
                    "type": "header",
                    "text": {
                      "type": "plain_text",
                      "text": "${ICON} ${{ inputs.workflow_name }} failed"
                    }
                  },
                  {
                    "type": "section",
                    "fields": [
                      { "type": "mrkdwn", "text": "*Repo*\n${{ github.repository }}" },
                      { "type": "mrkdwn", "text": "*Branch*\n${{ github.ref_name }}" },
                      { "type": "mrkdwn", "text": "*Job*\n${{ inputs.job_name }}" },
                      { "type": "mrkdwn", "text": "*Actor*\n${{ github.actor }}" }
                    ]
                  },
                  {
                    "type": "actions",
                    "elements": [
                      {
                        "type": "button",
                        "text": { "type": "plain_text", "text": "View run" },
                        "url": "${RUN_URL}"
                      }
                    ]
                  }
                ]
              }
            ]
          }
          JSON
          )

          curl -sS -X POST -H 'Content-Type: application/json' \
            --data "${PAYLOAD}" "${WEBHOOK}"
EOF

# ────────────────────────────────────────────────────────────────────────────
# 2. ci.yml — reusable CI: install, lint, typecheck, build
# ────────────────────────────────────────────────────────────────────────────
cat > .github/workflows/ci.yml << 'EOF'
# Reusable workflow: Next.js CI pipeline.
# Steps: install → typecheck → build.
# Lint is run only if a lint script exists (no fail if absent).
#
# Calling workflows pass node/pnpm versions if they need to override defaults.

name: CI

on:
  workflow_call:
    inputs:
      node_version:
        description: "Node.js version"
        required: false
        type: string
        default: "22"
      pnpm_version:
        description: "pnpm version"
        required: false
        type: string
        default: "11"
      working_directory:
        description: "Path to the app inside the repo"
        required: false
        type: string
        default: "."
    secrets:
      NEXT_PUBLIC_SENTRY_DSN:
        required: false
      SENTRY_AUTH_TOKEN:
        required: false
      SENTRY_ORG:
        required: false
      NEXT_PUBLIC_POSTHOG_KEY:
        required: false
      NEXT_PUBLIC_POSTHOG_HOST:
        required: false

jobs:
  build:
    name: Build & typecheck
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${{ inputs.working_directory }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ inputs.pnpm_version }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node_version }}
          cache: pnpm
          cache-dependency-path: ${{ inputs.working_directory }}/pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm exec tsc --noEmit

      - name: Lint (if configured)
        run: |
          if pnpm run | grep -qE "^\s*lint"; then
            pnpm run lint
          else
            echo "No lint script configured. Skipping."
          fi

      - name: Build
        env:
          NEXT_PUBLIC_SENTRY_DSN: ${{ secrets.NEXT_PUBLIC_SENTRY_DSN }}
          SENTRY_DSN: ${{ secrets.NEXT_PUBLIC_SENTRY_DSN }}
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          NEXT_PUBLIC_POSTHOG_KEY: ${{ secrets.NEXT_PUBLIC_POSTHOG_KEY }}
          NEXT_PUBLIC_POSTHOG_HOST: ${{ secrets.NEXT_PUBLIC_POSTHOG_HOST }}
          CI: "true"
        run: pnpm run build
EOF

# ────────────────────────────────────────────────────────────────────────────
# 3. README.md — usage docs
# ────────────────────────────────────────────────────────────────────────────
cat > README.md << 'EOF'
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
EOF

echo ""
echo "✓ Files written:"
echo "  .github/workflows/slack-alert.yml"
echo "  .github/workflows/ci.yml"
echo "  README.md"
echo ""
echo "Next:"
echo "  git add ."
echo "  git commit -m 'chore: scaffold reusable CI + Slack alert workflows'"
echo "  git push -u origin main"
