# CLAUDE.md

This is the rarebit-one **org-level** `.github` repo. It hosts shared reusable GitHub Actions workflows referenced by every gem and app in the workspace.

## Worktree-Only Workflow (Enforced)

**All file modifications are blocked in the main checkout.** A PreToolUse hook (`.claude/hooks/enforce-worktree.sh`, registered in `.claude/settings.json`) rejects Edit, Write, and NotebookEdit operations targeting files outside a worktree. The workspace-level hook also applies when Claude is started from the rarebit-one workspace root. There are no interactive opt-outs (the hook does exit 0 in `CI=true` / `GITHUB_ACTIONS` so the PR agent can make edits during automated runs).

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
- `.github/workflows/reusable-track-do-deployment.yml` — DigitalOcean deployment **tracker** (observes a `deploy_on_push` rollout, polls the DO API, probes the public URL, comments on the merged PR). Not a deployer.
- `.github/workflows/claude-agent.yml` — issue-triggered Claude PR agent
- `.github/workflows/claude-code-review.yml` — PR-triggered Claude review bot
- `.github/workflows/codeql-actions.yml` — CodeQL scanning for the Actions language
- `.github/workflows/pin-check.yml` — reusable PR gate: fails on un-SHA-pinned third-party actions (zizmor + pinact)
- `.github/workflows/pin-sweep.yml` — scheduled cross-repo self-healer: re-pins drift via `pinact run` and opens auto-merge PRs
- `.github/workflows/pr.yml`, `pin-check-caller.yml`, `deploy-production.yml`, `sentry-release.yml` — callers/dispatchers

See `docs/reusable-workflows.md` for the full input/output contract of each reusable workflow.

## Consumers

Every gem and app in the rarebit-one workspace consumes one or more workflows here:

```yaml
uses: rarebit-one/.github/.github/workflows/<name>.yml@<ref>
```

Consumers pin to a **moving major tag** (or a specific SHA) rather than `@main`, which works but offers no contract. The tag in use differs per workflow — re-point the relevant tag to `main` HEAD after merging a change, and consumers pick it up on their next run:

| Ref | Workflows |
|-----|-----------|
| `@v2` | **every versioned reusable**: `reusable-gem-ci`, `reusable-gem-release`, `reusable-weekly-maintenance`, `reusable-maven-central-release`, `sentry-release` |
| `@main` | `claude-agent`, `claude-code-review`, `deploy-production`, `dependabot-auto-merge`, `pin-check` and the other low-contract dispatchers — changes go live immediately on merge, by design |

**`v2` is the only live tag.** This table previously said `reusable-gem-ci` and
`sentry-release` were consumed at `@v1`. They are not, and had not been for
months: every live gem pins `@v2`, and the only remaining `@v1` references are in
two **archived** repos. Anyone following the old table would have re-pointed `v1`
and changed nothing for any live consumer — verified 2026-08-04. `v1` is retained
only so the archived repos' history resolves; never re-point it.

Because changes ripple across all consumers, test against at least one downstream consumer (e.g. a standard_* gem) before re-pointing a tag. There is no equivalent of `/rollout-gem` for these workflows.

**Re-point the tag in the same session as the merge.** The tag is the delivery
mechanism, not the merge — a change sitting on `main` behind a stale tag reaches
nobody while appearing shipped. On 2026-08-04 `v2` was found 20 commits and four
weeks behind `main`, so every gem had been running July-vintage shared CI:
runaway-timeout caps, auto-lander fixes and a CodeQL data-gap fix were all merged
but undelivered.

```bash
# after merging a change to a versioned reusable, and after the downstream test:
gh api -X PATCH repos/rarebit-one/.github/git/refs/tags/v2 \
  -f "sha=$(gh api repos/rarebit-one/.github/commits/main --jq .sha)" -F force=true
```

That downstream test is not a formality: it is what caught a `dependency-review`
job that failed on every gem (Dependency graph not enabled) before the tag move
could take all 8 gems red at once.

## Claude model

The Claude-invoking workflows (`claude-agent`, `claude-code-review`, `reusable-weekly-maintenance`) pin the model via a single per-file `env: CLAUDE_MODEL: "${{ vars.CLAUDE_MODEL || 'claude-opus-4-8' }}"`, referenced as `--model ${{ env.CLAUDE_MODEL }}`. **To bump the model org-wide**, set the `CLAUDE_MODEL` org variable (`gh variable set CLAUDE_MODEL --org rarebit-one --body <id> --visibility all`) — no PR or re-tag; `vars` resolves in the caller's context so it reaches every consumer. The literal is a safe fallback against an unset variable. See `docs/reusable-workflows.md` → "Claude model selection". (The same convention is mirrored in `fundbright/.github`.)
