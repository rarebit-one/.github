# CLAUDE.md

This is the rarebit-one **org-level** `.github` repo. It hosts shared reusable GitHub Actions workflows referenced by every gem and app in the workspace.

## Worktree-Only Workflow (Enforced)

**All file modifications are blocked in the main checkout.** A PreToolUse hook (`.agents/hooks/enforce-worktree.sh`, registered in `.claude/settings.json`) rejects Edit, Write, and NotebookEdit operations targeting files outside a worktree. The workspace-level hook also applies when Claude is started from the rarebit-one workspace root. There are no interactive opt-outs (the hook does exit 0 in `CI=true` / `GITHUB_ACTIONS` so the PR agent can make edits during automated runs).

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
- `.github/workflows/reusable-deploy-docr-staging.yml` — the build-once/promote staging **deployer** (`rarebit-sre#189`): builds the caller's image on a GitHub-hosted **x64** runner, pushes it to DOCR under an immutable per-SHA tag, and patches only the live app spec's image reference. Ships **inert** behind `docr_live`, and degrades to a loud green no-op when the token lacks registry write. `promote_only: true` is the rollback path. The build runner is hardcoded because DO runs amd64 and the mac-mini-1 runners are arm64.
- `.github/workflows/claude-agent.yml` — issue-triggered Claude PR agent
- `.github/workflows/codeql-actions.yml` — CodeQL scanning for the Actions language
- `.github/workflows/pin-check.yml` — reusable PR gate: fails on un-SHA-pinned third-party actions (zizmor + pinact)
- `.github/workflows/license-check.yml` — reusable third-party licence check over the caller's lockfiles; blocking by default since 2026-11-25 (`mode: enforce` fails on a blocked licence; `mode: report` never fails). Checker and org policy: `.github/scripts/license-check.py`, `.github/scripts/license-policy.json`; tests: `tests/license-check.test.py`
- `.github/workflows/pin-sweep.yml` — scheduled cross-repo self-healer: re-pins drift via `pinact run` and opens auto-merge PRs
- `.github/workflows/pr.yml`, `pin-check-caller.yml`, `reusable-branch-promote.yml`, `sentry-release.yml` — callers/dispatchers
- `.github/actions/do-app-deploy/` — composite behind `reusable-deploy-docr-staging.yml`'s promote: reads the live app spec over the DO REST API, repoints image sources with `patch-spec.jq`, PUTs it back, and fails with `SPEC_DRIFT` if the spec DO then holds differs anywhere else (`spec-drift.jq`; fundbright/delivery-ops#1019). Never route the spec write through a CLI's spec model. Tests: `tests/do-app-deploy-spec.test.sh`. The reusable workflow pins it by absolute SHA, so a change here ships in two PRs: the action, then the pin bump.
- `.github/scripts/do-spec-edit.sh` — the operator path for changing a LIVE App Platform spec by hand: `GET /v2/apps/{id}` → a jq filter on the raw spec → `PUT {"spec": …}` → the same `spec-drift.jq` check, with one extra rule (a plaintext SECRET value written may come back as `EV[…]`). Dry run by default, `--apply` to write, `--name` must match the live app. The `.do/*.yaml` headers and skills across the org point here instead of `doctl apps spec get` / `doctl apps update` round trips. Run it from a checkout of this repo (it reads `spec-drift.jq` beside the action). Tests: `tests/do-spec-edit.test.sh`.
- `.github/actions/setup-postgres/` — composite: root-free, docker-free PostgreSQL for CI (zonky relocatable build under `$RUNNER_TEMP`), so `services: postgres` jobs can move onto the jdb broker lane, where there is no docker. Mirrored from `luminalityai/.github`; `setup-postgres-smoke.yml` proves it on pg16/pg18 (hosted, free for this public repo).
- `.github/actions/hq-push/` — composite: send an alert to Rarebit HQ (`POST https://hq.rarebit.one/api/push`), which delivers it to the owner's installed HQ app as a Web Push notification. Inputs `key` (pass `secrets.HQ_PUSH_KEY`), `id` (stable per alert; HQ dedupes it for a few hours), `title`, `body`, `url` (defaults to the run), `severity`. Never fails the job; no-ops without a key. Consumers pin `@main` (low contract). Tests: `tests/hq-push-action.test.sh`.
- `evals/skills/` + `.github/workflows/skill-eval.yml` — headless evals of the estate's shared skills. `runner/` is the shared sandbox, stub CLIs, session driver and grader helpers (also usable by an eval kept beside a skill in another repo); `release/` evaluates `skills/release/SKILL.md`. PRs run only the credential-free grader (unit tests, positive control, fake-agent end-to-end runs); the live eval is **`workflow_dispatch` only** on GitHub-hosted runners, because it puts the org `CLAUDE_CODE_OAUTH_TOKEN` in an agent with unrestricted Bash. Tests: `node --test --test-concurrency=1 'evals/skills/**/*.test.mjs'`.

See `docs/reusable-workflows.md` for the full input/output contract of each reusable workflow.

## Consumers

Every gem and app in the rarebit-one workspace consumes one or more workflows here:

```yaml
uses: rarebit-one/.github/.github/workflows/<name>.yml@<ref>
```

Consumers pin to a **moving major tag** (or a specific SHA) rather than `@main`, which works but offers no contract. The tag in use differs per workflow:

| Ref | Workflows |
|-----|-----------|
| `@v3` | **every versioned reusable**: `reusable-gem-ci`, `reusable-gem-release`, `reusable-weekly-maintenance`, `reusable-maven-central-release`, `reusable-track-do-deployment`, `reusable-branch-promote`, `sentry-release` |
| `@main` | `claude-agent`, `dependabot-auto-merge`, `pin-check`, `license-check`, `estate-check` and the other low-contract dispatchers — changes go live immediately on merge, by design |

**`v3` is the only live tag, and it advances itself.** `advance-major-tag.yml`
moves the highest bare `vN` tag to `main` on every push to `main`, so a merged
change reaches every `@v3` caller on its next run; there is no manual re-point
step. `v1` and `v2` are frozen: no live caller pins them (verified 2026-11-23),
and they are kept only so old history resolves. Never re-point them. Creating a
`v4` freezes `v3`, because the advance job only moves the highest major.

Because the merge is the release, test a change to a versioned reusable against at
least one downstream consumer (e.g. a standard_* gem) **before merging**. There is
no equivalent of `/rollout-gem` for these workflows.

That downstream test is not a formality: it is what caught a `dependency-review`
job that failed on every gem (Dependency graph not enabled) before it could take
all 8 gems red at once.

## Claude model

The Claude-invoking workflows (`claude-agent`, `reusable-weekly-maintenance`) pin the model via a single per-file `env: CLAUDE_MODEL: "${{ vars.CLAUDE_MODEL || 'claude-sonnet-5-5' }}"`, referenced as `--model ${{ env.CLAUDE_MODEL }}`. **To bump the model org-wide**, set the `CLAUDE_MODEL` org variable (`gh variable set CLAUDE_MODEL --org rarebit-one --body <id> --visibility all`) — no PR or re-tag; `vars` resolves in the caller's context so it reaches every consumer. The literal is a safe fallback against an unset variable. See `docs/reusable-workflows.md` → "Claude model selection". (The same convention is mirrored in `fundbright/.github`.)
