---
name: release
description: "Production release manager for apps that ship with the shared branch-promote workflow. Runs pre-flight checks (pending commits per production branch, CI on the target SHA, staging, Sentry, DigitalOcean, production health), presents a briefing with a recommendation, and on the human's explicit go dispatches the app's promote workflow, watches it, and verifies the release left its three records. Invoke when the user says 'release', 'release to production', 'deploy to production', 'cut a release', 'promote to prod', 'prep a release', or '/release'."
model: opus
---

# Release

<!-- Vendored by estate-sync from rarebit-one/.github skills/release/SKILL.md.
     Edit it there, never here: estate-check fails a hand edit (sync.vendored).
     App-specific settings live in .agents/release.toml, extra checks in .agents/release.md. -->

Promotes `main` to production through the app's promote workflow, which calls the
estate's shared `reusable-branch-promote.yml` (sidekick-labs/sre-brain#832). That
workflow checks CI on the target, fast-forwards each production branch, tags
`vYYYY.MM.DD.N`, creates the GitHub Release, and records a Sentry production deploy.
Depending on the app, it also deploys and health-gates the DigitalOcean app, posts the
Slack release thread, and probes each region.

**The human decides.** This skill gathers facts, recommends, and dispatches only on
an explicit go. It never pushes a production branch, tags, or creates a Release by
hand: the workflow owns those, with the CI gate in front of them.

It does not roll back (see the playbook named in `release.toml`), merge PRs (`/land`),
or change app specs.

## Usage

```
/release                 # pre-flight + briefing + confirm
/release --dry-run       # same, but dispatch with dry_run=true
/release --ref <sha>     # promote up to <sha> (must be on main); default: main HEAD at briefing time
/release --target <name> # one region, for apps with a region input (see release.toml)
/release --skip-checks   # straight to confirmation
```

## Phase 0: Load the app's settings

```bash
python3 - <<'EOF'
import tomllib, json
print(json.dumps(tomllib.load(open(".agents/release.toml", "rb")), indent=2))
EOF
```

Missing or unreadable `.agents/release.toml` is a **blocker**: stop and say so. Keys:

| Key | Meaning |
|---|---|
| `app` | Display name |
| `promote_workflow` | The caller workflow to dispatch, e.g. `deploy-production.yml` |
| `ci_workflow` | The CI workflow the reusable gates on, e.g. `ci.yml` |
| `sentry_org`, `sentry_project` | Where production errors land |
| `doctl` | The DigitalOcean CLI wrapper bound to this app's team, e.g. `doctl-luminality` |
| `do_app_filter` | Regex over DO app names for this app |
| `staging_health_url` | Optional. Staging readiness URL, checked before promoting |
| `rollback_playbook` | URL of the rollback runbook to cite in the briefing |
| `region_input` | Optional. Name of the promote workflow's region choice input |
| `[[region]]` | One per production branch: `branch`, `health_url`, and `target` (the `region_input` value) |

If `.agents/release.md` exists, read it now. Its extra checks run in Phase 1, and its
notes override this skill where they're more specific.

## Phase 1: Pre-flight (run independent checks in parallel)

**Skip to Phase 3 with `--skip-checks`.**

1. **Pending commits, per production branch.**
   ```bash
   git fetch origin main                                   # a failure here is a blocker
   for b in <each region.branch>; do git fetch origin "$b" 2>/dev/null || true; done
   git log origin/<branch>..origin/main --format="%h %s (%an)" --reverse   # per branch
   ```
   - A missing production branch is a **blocker**: the workflow refuses to create one.
     It must be created at a known-good SHA by a human first.
   - Every target branch already at `main` (or at `--ref`): report a no-op and stop.
   - Branches at different SHAs: show each branch's pending count. Number the commits
     so the human can pick a cutoff.
   - Flag explicitly: database migrations (`git diff --stat origin/<branch>..origin/main -- '*db/migrate*' '*alembic*'`),
     `.do/` app-spec changes, and `.github/workflows/` changes.

2. **CI on the exact SHA being promoted.** The reusable gates on a successful
   `ci_workflow` run on `main` for that commit.
   ```bash
   SHA=$(git rev-parse "${REF:-origin/main}")
   gh run list --workflow=<ci_workflow> --branch=main --commit "$SHA" --json status,conclusion --jq '.[0]'
   ```
   - `success`: pass.
   - In progress: **Hold** until it finishes.
   - **Empty: STOP, not a pass.** The promote would fail with "no CI run". Offer to
     dispatch CI on `main` (`gh workflow run <ci_workflow> --ref main`) and wait. This
     usually means the merge produced no `push` event.
   - Failure: **Hold**.

3. **Staging** (when `staging_health_url` is set): `curl -fsS --max-time 10 <url>`. Expect
   `status: ok`, and the SHA being promoted where the payload reports a release.

4. **Sentry**: unresolved issues first seen or regressed in the last 24h in
   `sentry_project` (the Sentry MCP `search_issues`, or
   `sentry-cli issues list -o <org> -p <project> --query "is:unresolved firstSeen:-24h"`).
   Flag new high-severity issues.

5. **DigitalOcean** (in-progress deploys would collide with the promote):
   ```bash
   command -v <doctl> >/dev/null || echo "wrapper missing"
   <doctl> apps list --output json \
     | jq -r '.[] | select(.spec.name | test("<do_app_filter>"))
              | "\(.spec.name)\t\(.active_deployment.phase // "")\t\(.in_progress_deployment.id // "")"'
   ```
   - Use the wrapper from `release.toml`. **Never fall back to bare `doctl`**: it resolves
     whatever team was last selected, so the filter can match nothing and wrongly read
     as "no deploy in progress".
   - A missing wrapper, a failed command, or **zero matching apps** means **Unknown**,
     never clear.

6. **Production health, per region**: `curl -sS --max-time 10 <region.health_url>`.
   Parse `.status` where the endpoint returns JSON (`ok`, `degraded`, `unavailable`).
   Otherwise use the HTTP code (2xx is healthy).

7. **Extra checks** from `.agents/release.md`, if any.

## Phase 2: Briefing

```
## Production Release Briefing: <app>

Target: <sha> (main HEAD | --ref)          Next tag: v<YYYY.MM.DD>.<N>
Branches: <branch>: <n> pending  ...       (or "up to date")

  1. abc1234  <subject> (<author>)
  2. ...

Flags:      <migrations / .do / workflow changes, or none>
CI:         <Passing | In progress | Failing | No run> (<ci_workflow> @ <sha>)
Staging:    <ok | degraded | unavailable | skipped>
Sentry:     <N> new unresolved in 24h (<high-severity count>)
DO:         <no deploy in progress | in progress: <app> | Unknown (<why>)>
Health:     <branch>: <ok|degraded|unreachable> ...
Rollback:   <rollback_playbook>

Recommendation: <Safe to release | Release with caution | Hold>
```

The worst signal wins:

| Signal | Safe | Caution | Hold |
|---|---|---|---|
| CI on target | success | — | failing, in progress, or no run |
| Sentry (24h) | nothing new | 1–3 new, low severity | new high-severity |
| DO | no deploy in progress | Unknown | deploy in progress |
| Production health | ok | degraded | unavailable or unreachable |
| Flags | none | migrations, `.do/` or workflow changes | — |

## Phase 3: Confirm and dispatch

Ask the human to choose: release, release up to a numbered commit or SHA, one region
(when `region_input` is set), dry run, or abort. **Dispatch only on an explicit go.**

**Always pass the full SHA the briefing covered as `ref`**, even for a plain release.
Without it the workflow promotes whatever `main` is at dispatch time, which can include
commits merged after the briefing that nobody reviewed or checked on staging.

```bash
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run <promote_workflow> --ref main -f ref=<full SHA from the briefing> \
  [-f dry_run=true] [-f <region_input>=<target|all>]
# Select the run by dispatch time, not by SHA: the run carries main's SHA, not the ref input.
gh run list --workflow=<promote_workflow> --event workflow_dispatch --limit 5 \
  --json databaseId,createdAt,url --jq "[.[] | select(.createdAt >= \"$STARTED\")] | last"
gh run watch <id> --exit-status
```

If the dispatch is refused or no run appears within a minute, report it with the
Actions tab link. Never work around the workflow by pushing a production branch.

## Phase 4: Verify the release

Skip this phase for a dry run. Otherwise report each item as ✅ or ❌:

1. **Run result**: conclusion and URL. On failure, quote the failing step's
   `::error::`. Production branches only moved if the promote step succeeded.
   - A failed DO deploy or health gate after the branch moved can be **resumed by
     re-running the workflow**: it redeploys unless the live deployment is already
     that commit.
2. **Tag and Release**: `gh release view <tag> --json tagName,targetCommitish,url`. It
   must exist at the promoted SHA, titled with the tag.
3. **Sentry deploy**: the release named by the full SHA has a deploy in each region's
   environment (Sentry MCP `get_release_details`, or `sentry-cli releases info <sha>`).
4. **Live**: the workflow's DO phase and health verdict (when it deploys), each
   region's `health_url`, and the app's own tracking or smoke jobs when it has them.
   Follow them to completion before reporting.

Anything ❌ goes in the report with the next step: re-run (DO and health), the rollback
playbook (a bad release), or a follow-up issue (a missing record).

## Severity

- **Blockers (stop):** no `release.toml`; `git fetch origin main` fails; a production
  branch is missing; every target is already up to date.
- **Degraded (continue, show as Unknown):** `gh`, Sentry, the DO wrapper or a health URL
  is unavailable.
- **Hold (recommend against releasing):** CI failing, in progress or missing on the
  target; a deploy in progress; production unhealthy; new high-severity Sentry issues.
