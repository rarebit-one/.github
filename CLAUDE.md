# CLAUDE.md

This is the rarebit-one **org-level** `.github` repo. It hosts shared reusable GitHub Actions workflows referenced by every gem and app in the workspace.

## Worktree-Only Workflow (Enforced)

**All file modifications are blocked in the main checkout.** A PreToolUse hook (`.claude/hooks/enforce-worktree.sh`, registered in `.claude/settings.json`) rejects Edit, Write, and NotebookEdit operations targeting files outside a worktree. The workspace-level hook also applies when Claude is started from the rarebit-one workspace root. There are no opt-outs.

Before writing any code, create a worktree:

```bash
git fetch origin main
git worktree add .worktrees/<name> -b <branch-name> origin/main
```

Then work inside `.worktrees/<name>/` for the rest of the session.

## What lives here

- `.github/workflows/reusable-gem-ci.yml` — CI (lint + test matrix) for Ruby gems
- `.github/workflows/reusable-gem-release.yml` — trusted-publishing release to RubyGems via OIDC
- `.github/workflows/reusable-weekly-maintenance.yml` — scheduled `bundle outdated` + bundler-audit
- `.github/workflows/claude-agent.yml` — issue-triggered Claude PR agent
- `.github/workflows/claude-code-review.yml` — PR-triggered Claude review bot
- `.github/workflows/codeql-actions.yml` — CodeQL scanning for the Actions language
- `.github/workflows/pr.yml`, `deploy-production.yml`, `sentry-release.yml` — callers/dispatchers

See `docs/reusable-workflows.md` for the full input/output contract of each reusable workflow.

## Consumers

Every gem and app in the rarebit-one workspace consumes one or more workflows here:

```yaml
uses: rarebit-one/.github/.github/workflows/<name>.yml@v1
```

Pin to `@v1` (or a specific SHA) for stability — `@main` works but offers no contract. Because changes ripple across all consumers, test against at least one downstream consumer (e.g. a standard_* gem) before tagging a new `v1.x` release.

There is no equivalent of `/rollout-gem` for these workflows — consumers pick up the new `v1` tag automatically on their next CI run.
