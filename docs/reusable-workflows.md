# Reusable Workflows

This repo hosts reusable GitHub Actions workflows shared across rarebit-one
gems and apps. Consumers reference workflows here via:

```yaml
uses: rarebit-one/.github/.github/workflows/<name>.yml@v2
```

Pin to the `v2` tag (or a specific SHA) — `@main` works but does not give you
a stable contract.

Available reusable workflows:

- **`reusable-gem-ci.yml`** — CI for Ruby gems (lint + Ruby-version test matrix).
- **`reusable-gem-release.yml`** — gem release via release-please + RubyGems push.
- **`reusable-maven-central-release.yml`** — Maven Central release via Gradle.
- **`reusable-weekly-maintenance.yml`** — weekly dependency-update / lint / test /
  CodeQL-alert sweep across every stack.

> **Removed:** `reusable-sentry-autofix.yml` — the Sentry autofix moved to the
> one-workflow-per-org model: `rarebit-one/rarebit-sre`'s `sentry-sweep.yml` +
> `sentry-autofix-engine.yml` now run the triage/fix cross-repo via the
> release-bot App token (rarebit-sre#5). Config lives in rarebit-sre's
> `sources.yaml sentry.autofix`.

## Actions-pinning self-healer

Third-party GitHub Actions across the estate are SHA-pinned (via `pinact`,
config `.pinact.yaml`). Three pieces keep that compliant over time:

- **`pin-check.yml`** — a reusable (`workflow_call`) PR gate. It runs
  [zizmor](https://docs.zizmor.sh) (the Actions security auditor) and blocks the
  PR on its `unpinned-uses` finding, plus a second, config-aware `pinact --check`
  (via `suzuki-shunsuke/pinact-action`, `fix: "false"`). zizmor's full audit is
  surfaced as non-blocking log; only pinning blocks the merge. First-party org
  actions pinned at `@main`/`@vN` are allowed — the gate reads the repo's
  `.github/zizmor.yml` if present, else synthesizes an owner-scoped policy from
  `github.repository_owner` (`<owner>/*: ref-pin`, `*: hash-pin`), so it's
  portable to any org with no per-repo config.

  Consume it from a PR workflow (see `pin-check-caller.yml` here for the
  reference wiring):

  ```yaml
  jobs:
    pin-check:
      uses: rarebit-one/.github/.github/workflows/pin-check.yml@main
  ```

- **`pin-sweep.yml`** — a scheduled (`schedule` weekly + `workflow_dispatch`)
  self-healer that lives only in this org `.github` repo. It enumerates every
  non-archived org repo (via the release-bot App token), runs `pinact run` on
  each honoring that repo's `.pinact.yaml` (seeding the org-standard one where
  it's missing), and — if pinact produces a diff — opens a squash-auto-merge PR
  on that repo with the fix. Auth + cross-repo mechanics mirror rarebit-sre's
  `ci-fix-sweep.yml`: `actions/create-github-app-token`
  (`vars.RELEASE_BOT_CLIENT_ID` + `secrets.RELEASE_BOT_PRIVATE_KEY`), a repo
  matrix, per-target checkout, and a server-signed commit created via the API
  (push to the `pin-fix/*` branch is unsigned, then HEAD is replaced with a
  signed commit and the ref re-pointed) so PRs land even on
  require-signed-commits repos. `workflow_dispatch` supports `dry_run` (plan
  only) and `only_repo` (scope to one repo for validation).

- **Dependabot `github-actions`** — this repo's `.github/dependabot.yml` already
  enables the weekly `github-actions` ecosystem, so the pinned SHAs get bumped
  as new releases land. **Fan-out note:** each consumer repo needs this same
  `github-actions` block in its *own* `.github/dependabot.yml` — the sweep pins,
  Dependabot freshens; they're complementary.

## Auto-lander merge token (App → `AUTOLAND_PAT` → `GITHUB_TOKEN`)

`dependabot-auto-merge.yml` (the org auto-lander) enables native squash
auto-merge on Dependabot PRs, autonomous SRE-engine PRs, and the maintainer's
own PRs. **Which token performs the enable decides whether the resulting merge
emits a `push` event.**

GitHub does not emit workflow-triggering events for actions taken with the
automatic `GITHUB_TOKEN`. Native auto-merge is attributed to whoever enabled
it, so an enable done with `GITHUB_TOKEN` merges as `github-actions[bot]` and
fires **no `push` event** — which silently skips `deploy.yml` (chained off
`workflow_run` of main CI) and `sentry-release.yml` (`push: main`) in every app
repo. Verified on nutripod-web: auto-landed `c99c3084` has zero `push` /
`workflow_run` runs; the human-merged commits either side of it have both.

### Why an App token, not a PAT

#79 shipped this fix as `AUTOLAND_PAT` — and it never took effect, because the
secret was never created. All 20 consumer repos fell through to `GITHUB_TOKEN`
for the whole window, announcing it into job logs nobody read. jumpdrive-web#566
has the forensics: 17 consecutive `main` commits with **zero** `push` runs,
which also broke that repo's release gate (the promote reusable looks for a CI
run on the promoted SHA and found none, so `/release` needed a manual `Test`
dispatch first).

The lesson is not "remember to mint the PAT" — it is that a fix gated on a human
creating a credential out-of-band is a fix that reliably does not ship.

A **GitHub App installation access token** clears the loop-prevention rule
exactly as a PAT does, and this org already has the App installed everywhere:

| | |
|---|---|
| App | `rarebit-one`, id `3896724`, installed on **all** repositories |
| Permissions | `contents: write` · `pull_requests: write` |
| Client id | `RELEASE_BOT_CLIENT_ID` — org **variable**, visibility *All repositories* |
| Private key | `RELEASE_BOT_PRIVATE_KEY` — org **secret**, visibility *All repositories* |

No new credential, no expiry to forget, not attributed to a person, revocable
independently of anyone's account.

### Precedence

1. **release-bot App token** — minted per-run via `actions/create-github-app-token`,
   scoped down to `contents: write` + `pull-requests: write`. The normal path.
2. **`AUTOLAND_PAT`** — retained as a middle rung because `rarebit-static-v3`
   holds a repo-level one, and a repo secret is not overridden by an org secret
   of the same name. Also covers any repo where the App is uninstalled.
3. **`GITHUB_TOKEN`** — degraded. Emits a `::warning::` plus a job-summary block
   naming the workflows that will not fire, and a troubleshooting checklist. The
   fallback is never silent.

Reads and the Dependabot approval always keep `GITHUB_TOKEN`; only the
`gh pr merge --auto` enable uses the elevated token. Moving the approval would
be a governance change, not a push-event fix.

The decision summary at the end of every run carries a **merge token** row, so
which rung was used is visible on each PR without reading the log.

**Callers must pass `secrets: inherit`** — without it `RELEASE_BOT_PRIVATE_KEY`
never reaches the reusable and the App rung drops silently to the next one.

### The `anthropics/claude-code-action` exemption (org convention)

We pin `anthropics/claude-code-action` to a **main-branch commit** (ahead of the
latest release, for a thinking-block 400 fix — see rarebit-ops#119), annotated
`# main@<version>` rather than `# v<semver>`. `pinact --check` flags that comment
style as a missing semver comment and would try to "correct" the deliberate main
pin. The consistent handling, applied in **every org's `.pinact.yaml`**, is to
list it under `ignore_actions`:

```yaml
version: 3
ignore_actions:
  - name: rarebit-one/.*        # first-party org actions (moving @main/@vN OK)
    ref: .*
  - name: \./.*                 # local composite actions (no upstream ref)
    ref: .*
  - name: anthropics/claude-code-action
    ref: .*
```

This **only** exempts it from `pinact`'s semver-comment nit. It stays SHA-pinned,
and zizmor's `unpinned-uses` still enforces that it's a full SHA — so the
supply-chain guarantee is intact; we've only silenced a false "correct me" from
the semver-comment heuristic. Replicate this block verbatim when fanning the
self-healer out to the other orgs' `.github` repos.

## Claude model selection

Every workflow that invokes `anthropics/claude-code-action` (`claude-agent`,
`claude-code-review`, `reusable-weekly-maintenance`)
resolves the model from a single source:

```yaml
env:
  CLAUDE_MODEL: "${{ vars.CLAUDE_MODEL || 'claude-opus-4-8' }}"
# referenced at each call site as: --model ${{ env.CLAUDE_MODEL }}
```

- **To change the model org-wide**, set the `CLAUDE_MODEL` organization Actions
  variable — `gh variable set CLAUDE_MODEL --org rarebit-one --body <id> --visibility all`.
  No PR or re-tag needed: `vars` resolves in the **caller's** context, so the
  org variable reaches every consumer on its next run.
- The literal (`claude-opus-4-8`) is a **fallback** so an unset variable can't
  produce an empty `--model` (which would silently fall back to the action's
  own default — the drift this guards against).
- Composite actions can't read `vars`, so any composite that wraps
  `claude-code-action` keeps its own literal `--model` instead.

## `reusable-gem-ci.yml`

CI workflow for Ruby gems with three jobs: `lint`, `test-matrix` (one
leg per Ruby version, displays as `Ruby <version>`), and `test` (an
aggregator that depends on `test-matrix` and emits a single rolled-up
`test` check). Replaces the per-gem `.github/workflows/ci.yml` files.

Branch protection on consumer repos can require `<caller-job> / lint`
and `<caller-job> / test` without enumerating every Ruby leg, so adding
or removing a Ruby version doesn't require updating protection. The
aggregator is safe to require unconditionally: it runs with
`if: always()` and explicitly fails when any matrix leg fails (rather
than skipping, which GitHub branch protection would treat as passing).
In lint-only mode (`ruby-versions: '[]'`), the aggregator passes
because the matrix is intentionally skipped.

### Inputs

| Input                | Type    | Required | Default                          | Description |
|----------------------|---------|----------|----------------------------------|-------------|
| `ruby-versions`      | string  | no       | `"[]"`                           | JSON array of Ruby versions for the test matrix, e.g. `'["4.0.0","4.0.3"]'`. When omitted or `'[]'`, the test job is skipped (lint-only). |
| `lint-ruby-version`  | string  | no       | `"4.0.3"`                        | Ruby version used for the lint job. |
| `lint-cache-paths`   | string  | no       | `""`                             | Multiline list of filesystem paths to cache around the lint command (e.g. RuboCop result cache). When set together with `lint-cache-key`, wraps the lint step with `actions/cache@v5`. |
| `lint-cache-key`     | string  | no       | `""`                             | Cache key paired with `lint-cache-paths`. Required when `lint-cache-paths` is set; ignored otherwise. |
| `apt-packages`       | string  | no       | `""`                             | Space-separated apt packages installed before the test job. |
| `pre-test-commands`  | string  | no       | `""`                             | Multiline shell run before the test command (db setup, asset build). |
| `test-command`       | string  | no       | `bundle exec rspec`              | Command run by the test job. |
| `lint-command`       | string  | no       | `bundle exec rubocop -f github`  | Primary lint command. |
| `extra-lint-commands`| string  | no       | `""`                             | Multiline shell run after the primary lint command (brakeman, bundler-audit, etc.). |
| `upload-screenshots` | boolean | no       | `false`                          | When true, upload `tmp/screenshots/` as `screenshots-<ruby>` on test failure. |
| `concurrency-group`  | string  | no       | `""`                             | Override for the workflow concurrency group. Empty falls back to `<workflow>-<pr-or-ref>`. |

### Behavior

- All jobs run on `ubuntu-latest`.
- `actions/checkout@v6`, `ruby/setup-ruby@v1` (with `bundler-cache: true`),
  `actions/upload-artifact@v7`.
- Test matrix has `fail-fast: false`.
- The `test` aggregator runs with `if: always()` and inspects
  `needs.test-matrix.result`: `success` and `skipped` (lint-only) pass,
  anything else fails. Safe to require unconditionally in branch
  protection.
- Default concurrency cancels in-progress runs scoped to the PR or ref.
- Permissions: `contents: read`, `pull-requests: read`.

### Example — minimal pure-Ruby gem

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    uses: rarebit-one/.github/.github/workflows/reusable-gem-ci.yml@v1
    with:
      ruby-versions: '["3.4.4","4.0.3"]'
```

### Example — Rails engine with Chrome + asset build

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    uses: rarebit-one/.github/.github/workflows/reusable-gem-ci.yml@v1
    with:
      ruby-versions: '["4.0.3"]'
      apt-packages: 'build-essential git libyaml-dev pkg-config google-chrome-stable'
      pre-test-commands: |
        bin/rails db:test:prepare
        bin/rails app:tailwindcss:build
      extra-lint-commands: |
        bin/brakeman --no-pager
        bundle exec bundler-audit --update
      upload-screenshots: true
```

### Example — lint-only with RuboCop cache

When a gem only needs lint coverage in CI (no test matrix), omit
`ruby-versions` to skip the test job. Pair `lint-cache-paths` and
`lint-cache-key` to persist RuboCop's incremental result cache across runs.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  ci:
    uses: rarebit-one/.github/.github/workflows/reusable-gem-ci.yml@v1
    with:
      lint-cache-paths: |
        ~/.cache/rubocop_cache
      lint-cache-key: rubocop-${{ runner.os }}-${{ hashFiles('.rubocop.yml', 'Gemfile.lock') }}
```

## `reusable-gem-release.yml`

Two-job release workflow (`release` + `publish`) triggered on `v*` tags.
Validates the tag against the gemspec, extracts CHANGELOG notes, creates a
GitHub Release, and publishes to RubyGems via OIDC trusted publishing.

### Inputs

| Input               | Type   | Required | Default                          | Description |
|---------------------|--------|----------|----------------------------------|-------------|
| `gem-name`          | string | yes      | —                                | Gem name (matches `spec.name`). Also used to derive the default version-file path. |
| `ruby-version`      | string | no       | `"4.0.3"`                        | Ruby used for verification and publish. |
| `version-file`      | string | no       | `lib/<gem-name>/version.rb` (with `-` → `/`) | Override the version file location. |
| `changelog-path`    | string | no       | `CHANGELOG.md`                   | Path to the changelog file. |
| `sibling-checkouts` | string | no       | `"[]"`                           | JSON array of sibling repos to clone before `bundle install` in the publish job. Each entry: `{"repo": "owner/name", "path": "../name", "ref": "optional"}`. Used by gems whose Gemfile resolves a `path:` dependency on a sibling repo so `bundler-cache: true` can resolve. Authentication uses the workflow's `GITHUB_TOKEN`; sibling repos must be readable by it. |

### Behavior

- The `release` job runs with `permissions: contents: write`.
- The `publish` job uses the `rubygems` GitHub Environment and
  `permissions: id-token: write` for OIDC trusted publishing.
- Uses pinned action SHAs for `actions/checkout` and `rubygems/release-gem`.
- Tag validation loads the gemspec — gems whose gemspec sources `spec.version`
  from `lib/<gem>/version.rb` are transitively validated. The version-file
  path existence check emits a warning if missing.

### Example

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    uses: rarebit-one/.github/.github/workflows/reusable-gem-release.yml@v2
    with:
      gem-name: standard_id
```

### Example — gem with a sibling-repo path dependency

When a gem's `Gemfile` resolves a `path:` dependency on a sibling repo (e.g.
`ground_control-inertia` → `../ground_control-api`), declare the sibling so the
publish job can clone it before `bundle install`.

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    uses: rarebit-one/.github/.github/workflows/reusable-gem-release.yml@v2
    with:
      gem-name: ground_control-inertia
      sibling-checkouts: |
        [{"repo": "rarebit-one/ground_control-api", "path": "../ground_control-api"}]
```

## `reusable-maven-central-release.yml`

Two-job release workflow (`release` + `publish`) triggered on `v*` tags for
Kotlin Multiplatform libraries publishing to Maven Central via
[vanniktech/gradle-maven-publish-plugin][vanniktech]. Validates the tag
against `gradle.properties`, extracts CHANGELOG notes, creates a GitHub
Release, then runs `./gradlew publishAndReleaseToMavenCentral` to push the
artifacts (with in-memory GPG signing) and auto-release the staging
repository via the Central Portal API.

The `publish` job runs in a GitHub Environment (default `maven-central`) so
secrets can be env-scoped and `v*` tag-deployment-branch-policy can gate
which refs may publish.

[vanniktech]: https://github.com/vanniktech/gradle-maven-publish-plugin

### Inputs

| Input             | Type   | Required | Default          | Description |
|-------------------|--------|----------|------------------|-------------|
| `project-name`    | string | yes      | —                | Project name (for log clarity only). |
| `version-key`     | string | no       | `VERSION_NAME`   | gradle.properties key holding the release version. |
| `changelog-path`  | string | no       | `CHANGELOG.md`   | Path to the changelog file. |
| `jdk-version`     | string | no       | `21`             | JDK version for the build/publish job. |
| `publish-runs-on` | string | no       | `macos-latest`   | Runner OS for the publish job. KMP iOS/macOS targets require `macos-latest`. JVM-only libraries can downgrade to `ubuntu-latest`. |
| `environment`     | string | no       | `maven-central`  | GitHub Environment for the publish job. |

### Required secrets (inherited via `secrets: inherit`)

Recommended at GitHub Environment scope rather than repo scope:

| Secret                    | Description |
|---------------------------|-------------|
| `SIGNING_KEY`             | ASCII-armored GPG private key (no passphrase). |
| `SIGNING_KEY_ID`          | Last 8 hex chars of the GPG fingerprint. Explicit selection guards against future key rotations silently using the wrong key. |
| `MAVEN_CENTRAL_USERNAME`  | Sonatype Central Portal user token name. |
| `MAVEN_CENTRAL_PASSWORD`  | Sonatype Central Portal user token value. |

### Behavior

- The `release` job runs on `ubuntu-latest` with `permissions: contents: write`.
- The `publish` job runs on the configured runner (default `macos-latest`),
  uses the configured GitHub Environment, and only `permissions: contents: read`.
- Tag validation grep's the `version-key` from `gradle.properties`. The
  consumer build is expected to read `VERSION_NAME` (vanniktech's default).
- Publish uses `--no-configuration-cache` because vanniktech is incompatible
  with Gradle configuration cache.

### Example

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    uses: rarebit-one/.github/.github/workflows/reusable-maven-central-release.yml@v1
    with:
      project-name: ktor-armour
    permissions:
      contents: write
    secrets: inherit
```

### Example — JVM-only library (faster runner)

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    uses: rarebit-one/.github/.github/workflows/reusable-maven-central-release.yml@v1
    with:
      project-name: my-jvm-lib
      publish-runs-on: ubuntu-latest
    permissions:
      contents: write
    secrets: inherit
```

## `reusable-weekly-maintenance.yml`

Single reusable workflow that drives the weekly maintenance cron across every
stack in the org (Rails apps, Ruby gems, Node libraries, Node apps, Kotlin
Multiplatform). Replaces per-repo `weekly-maintenance.yml` files.

A run does the following:

1. Validates the `stack` input and required secrets (fails fast before
   checkout).
2. Sets up the toolchain for the chosen stack (Ruby/Node/JDK+Gradle).
3. Captures a TODO/FIXME census, restoring last week's snapshot from cache and
   computing a delta.
4. Captures open CodeQL code-scanning alerts (when `review-security-alerts` is
   true) to `tmp/maintenance/codeql-alerts.json` for the prompt.
5. Hands off to `anthropics/claude-code-action` with a stack-aware prompt that
   runs the dependency updates, reviews any open code-scanning alerts (fixing
   actionable ones, reporting the rest — never dismissing), runs the
   verification commands you supply (`lint-commands`, `test-commands`, or
   `gradle-test-command`), and — only when verification passes — opens a signed
   PR via the GitHub API.
6. Uploads `tmp/maintenance/` (prompt, TODO/FIXME census + diff) as an
   artifact for inspection.

### Inputs

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `stack` | string | yes | — | One of `rails`, `ruby-gem`, `node-lib`, `node-app`, `kmp`. |
| `ruby-version-file` | string | no | `.ruby-version` | Used for the `rails` and `ruby-gem` stacks unless `ruby-version` is set. |
| `ruby-version` | string | no | `""` | Explicit Ruby version override. Wins over `ruby-version-file` when non-empty. |
| `node-version` | string | no | `lts/*` | Used for the `rails`, `node-lib`, `node-app` stacks. |
| `jdk-version` | string | no | `17` | Used for the `kmp` stack. |
| `bundle-update-strategy` | string | no | `lock-update` | `lock-update`, `conservative`, or `none`. Controls how the prompt asks Claude to update Bundler. |
| `run-bundler-audit` | boolean | no | `true` | Add a `bundler-audit check --update` step to the prompt (Ruby stacks). |
| `run-brakeman` | boolean | no | `false` | Add a `bin/brakeman` step to the prompt (Rails stack). |
| `run-sorbet-rbi` | boolean | no | `false` | Regenerate Sorbet RBIs via `bin/tapioca dsl/gems/annotations` and include drift in the PR (Rails stack). |
| `run-npm-audit` | boolean | no | `true` | Add an `npm audit fix` step (stacks with `package.json`). |
| `lint-commands` | string | no | `""` | Multiline shell — every line is a verification command (e.g. `bin/rubocop`, `npm run lint`). |
| `test-commands` | string | no | `""` | Multiline shell — full test-suite verification commands. |
| `gradle-test-command` | string | no | `./gradlew test` | KMP test command. |
| `additional-allowed-tools` | string | no | `""` | Comma-separated entries appended to `--allowed-tools`. |
| `todo-fixme-paths` | string | no | `.` | Space-separated paths scanned for TODO/FIXME. |
| `todo-fixme-exclude` | string | no | (sensible defaults) | Space-separated globs excluded from the census. |
| `timeout-minutes` | number | no | `45` | Job-level timeout. |
| `claude-timeout-minutes` | number | no | `25` | Timeout for the Claude action step. |
| `review-security-alerts` | boolean | no | `true` | Fetch open CodeQL code-scanning alerts (via `security-events: read`, `tool_name=CodeQL`, up to 100 per run) into the prompt so Claude fixes actionable ones and reports the rest in the PR. Never auto-dismisses. Tolerates repos without code scanning. |

### Secrets

| Secret | Required | Description |
|---|---|---|
| `claude-code-oauth-token` | yes | OAuth token for `anthropics/claude-code-action`. |

### Behavior

- Top-level `permissions: {}`; the job re-grants `contents: write`,
  `pull-requests: write`, `id-token: write` for the signed-commit + PR flow,
  plus `security-events: read`. The read scope is always granted (Actions has a
  static permissions model) but is only exercised when `review-security-alerts:
  true`; it is never `write`, so the workflow can never dismiss alerts.
- All third-party actions are SHA-pinned (checkout, ruby/setup-ruby,
  setup-node, anthropics/claude-code-action). KMP-only setup-java and
  setup-gradle remain on floating major tags pending org-wide pinning.
- Risky judgment-call items (major bumps, code-changing fixes, design-decision
  TODOs) are summarised in the PR body (or the run output when there's no PR)
  for a human to pick up. No issue tracker is written to.
- **Crash heartbeat.** A second job, `alert`, runs `if: always()` after
  `maintenance` and turns a *missed* beat into a durable record: it opens ONE
  deduped `beat failure: weekly-maintenance` issue and closes it on recovery
  (recovery is gated on an actual `success`, so an all-skipped run is not read as
  recovery). It exists because the maintenance job's own reporting only helps if
  the job REACHED it — a run that dies at token mint, `npm ci` or a runner death
  would otherwise be invisible.
  **This makes `issues: write` a mandatory caller grant** (see the note above the
  examples): a reusable's token is capped by the caller's, so a caller missing it
  lands in `startup_failure`. Every `gh issue` call is best-effort (`|| true`)
  because most consumer repos have Issues DISABLED — there the miss degrades to a
  `::warning::` annotation rather than turning a green run red.
- TODO/FIXME census uses `actions/cache` to keep the previous run's snapshot
  scoped per `repository_id`; week-over-week delta surfaces in `$GITHUB_STEP_SUMMARY`
  and in the PR body.

### Example — Rails app (fundbright-web, nutripod-web)

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write
  security-events: read

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v2
    with:
      stack: rails
      run-brakeman: true
      run-sorbet-rbi: true
      lint-commands: |
        bin/rubocop
        npm run lint
        npm run check
      test-commands: |
        bin/rspec
        npm run test:run
      additional-allowed-tools: 'Bash(bin/rspec:*),Bash(npm run test:run:*)'
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Example — Ruby gem (standard_id, standard_audit, standard_circuit)

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write
  security-events: read

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v2
    with:
      stack: ruby-gem
      ruby-version: '4.0.3'
      lint-commands: |
        bundle exec rubocop
      test-commands: |
        bundle exec rspec
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Example — Node library

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write
  security-events: read

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v2
    with:
      stack: node-lib
      node-version: '20'
      lint-commands: |
        npm run lint
        npm run check
      test-commands: |
        npm run test:run
        npm run build
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Example — Kotlin Multiplatform

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions: {}

jobs:
  maintenance:
    # A reusable workflow's token is capped by the CALLER's permissions. A
    # job-level block fully replaces the top-level one for this job, so every
    # permission the reusable needs must be listed HERE.
    permissions:
      contents: write
      pull-requests: write
      issues: write         # crash-heartbeat `alert` job
      id-token: write
      security-events: read
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v1
    with:
      stack: kmp
      jdk-version: '17'
      gradle-test-command: ./gradlew :composeApp:testDebugUnitTest
      additional-allowed-tools: 'Bash(./gradlew :composeApp:testDebugUnitTest:*)'
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

## `reusable-track-do-deployment.yml`

Tracks a DigitalOcean App Platform deployment to a terminal phase, verifies the
app is publicly reachable, and posts the outcome to the merged PR.

**It does not deploy.** Every consumer uses DO's native git integration
(`deploy_on_push`), so DO has already started the rollout when this runs. This
observes it. A bug here yields a wrong CI signal — it cannot break, stall, or
roll back a deploy. (Contrast `sidekick-labs/.github`'s `reusable-deploy-*`,
which are DOCR *deployers* that rewrite the appspec and delete its `github:`
block. Different problem; not interchangeable.)

### Inputs

| Input | Required | Default | Notes |
|-------|----------|---------|-------|
| `environment` | yes | — | GitHub environment name. Also the PR-comment marker scope, so each environment maintains its own comment. This is where region-awareness lives: `production-sg` / `production-my` are two calls, not a region input. |
| `environment_url` | yes | — | Public base URL; both probes are appended to it. |
| `expected_commit_sha` | yes | — | The commit to track. Under `workflow_run`, use `github.event.workflow_run.head_sha` — `github.sha` is the workflow file's commit. |
| `poll_interval` | no | `15` | Seconds between DO API polls. |
| `poll_timeout` | no | `600` | Max seconds to wait for a terminal phase. |
| `health_path` | no | `""` | **Blocking** reachability gate, probed after DO reports ACTIVE. Empty = skipped. Takes the **liveness** tier deliberately. |
| `readiness_path` | no | `""` | **Non-blocking** readiness report in the step summary. Empty = skipped. Never gates. |
| `enable_triage` | no | `true` | Post-failure DO triage (step statuses, restart counts, last 40 log lines). Additive only. |

### Outputs

| Output | Notes |
|--------|-------|
| `deploy_id` | DO deployment id tracked (empty if none resolved). |
| `phase` | Terminal phase. `SUPERSEDED` is re-emitted for a CANCELED-by-newer-deploy. |

### Secrets

`DIGITALOCEAN_ACCESS_TOKEN` and `DIGITALOCEAN_APP_ID` (both required). The app-id
secret is per-app on the caller side — `DO_APP_ID`, `DO_STAGING_APP_ID`,
`DO_MARKETING_APP_ID`, `DO_DOCS_APP_ID`, `DO_PRODUCTION_APP_ID_SG`/`_MY` — mapped
onto the single `DIGITALOCEAN_APP_ID` name here. That mapping is what lets one
repo track several apps from one run.

### Caller permissions — the startup-failure trap

The caller **must** grant `deployments: write` and `pull-requests: write`. A
called workflow can only receive permissions the caller holds; withhold either
and the run fails at **startup** — no jobs, no error in the API.

### Why the probe defaults are empty

A non-empty shared default would impose a *new* blocking gate on a consumer that
does not serve that path and red a healthy deploy. Pass the path explicitly:

| Consumer | `health_path` | `readiness_path` |
|---|---|---|
| `jumpdrive-web` (staging + production-deploy) | `/up` | `""` |
| `jumpdrive-static` (marketing + docs) | `/` | `""` |
| `jumpdrive-runner` | `/health` | `""` |
| `rarebit-static-v3` | `""` (no gate today) | `""` |
| `nutripod-web` (staging, production-sg, production-my) | `/health/alive` | `/health/ready` |

### Two incident-derived behaviours — do not regress

1. **Public reachability probe** (`jumpdrive-web#163`) — DO reported ACTIVE while
   the edge was not routing and every public request 504'd. `phase == ACTIVE` is
   not treated as sole ground truth here.
2. **CANCELED → SUPERSEDED disambiguation** (originated `rarebit-static-v3`,
   backported in `nutripod-web#1144`) — DO uses CANCELED both for "a newer deploy
   took over" (benign) and for a genuine abort. Treating both as red fired a
   false 🚨 in `#releases` while production was healthy. Disambiguated by fact:
   does DO hold a deployment created after this one.

### Example

```yaml
  track:
    needs: deploy
    uses: rarebit-one/.github/.github/workflows/reusable-track-do-deployment.yml@<sha> # main
    with:
      environment: production-sg
      environment_url: https://www.nutripod.com.sg
      expected_commit_sha: ${{ needs.promote.outputs.sha }}
      health_path: /health/alive
      readiness_path: /health/ready
    secrets:
      DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
      DIGITALOCEAN_APP_ID: ${{ secrets.DO_PRODUCTION_APP_ID_SG }}
```

Consumers should pin a **SHA** (`@<sha> # main`) rather than `@main`: after
consolidation a single edit here reaches five repos at once, and the tracker's
dangerous failure mode is a false green.

## `reusable-deploy-docr-staging.yml`

The **build-once / promote** staging deployer (`rarebit-sre#189`). Unlike
`reusable-track-do-deployment.yml`, which only *observes* a `deploy_on_push`
rollout, this one produces the artifact and moves it: build the caller's
Dockerfile at an exact SHA on a GitHub-hosted x64 runner → push to DOCR tagged
with that SHA → patch **only** the live app spec's image reference → poll to
ACTIVE.

It exists because DigitalOcean builds each environment independently from
GitHub, so production runs a *different build* from the one staging validated,
and no rarebit workflow has a rollback path. An immutable per-SHA tag fixes
both.

### Two things this file will not let you get wrong

1. **`runs-on: ubuntu-latest` is hardcoded and must stay that way.** DO App
   Platform runs amd64; the mac-mini-1 self-hosted runners are arm64. Routing the
   build through `vars.RUNNER_LABEL` would push an arm64 image that builds green
   and fails at container start inside DO, far from its cause. `platforms:
   linux/amd64` is set explicitly for the same reason.
2. **It ships INERT.** `docr_live` must be the literal string `"true"` before the
   live spec is touched. Unarmed it still builds, still pushes, still reads the
   live spec and still prints the exact promotion — it just does not apply it.

### Inputs

| Input | Required | Default | Notes |
|-------|----------|---------|-------|
| `deploy_sha` | yes | — | The SHA CI validated; also the image tag. With `promote_only`, the **existing** tag to promote. |
| `registry` | yes | — | DOCR registry name (`fundbright`, `luminality`, `rarebit-one`). |
| `image_repo` | yes | — | Repository within that registry. |
| `app_url` | yes | — | Ingress URL, for the GitHub Deployment link and summary. |
| `environment` | no | `staging` | GitHub Deployment environment name. |
| `dockerfile` / `context` | no | `./Dockerfile` / `.` | Build inputs. |
| `build_args` | no | `""` | Multiline `KEY=VALUE`. Never secrets — visible in `docker history`. |
| `build_secrets` / `build_secret_id` | no | `""` | BuildKit secrets; `build_secret_id`'s value comes from the `BUILD_SECRET_VALUE` secret. |
| `promote_only` | no | `false` | **The rollback path.** Skips build and push; promotes an existing tag after verifying it exists. |
| `docr_live` | no | `""` | Arming gate. Pass a repo variable so arming is a `gh variable` command, never a code change. |
| `free_disk_space` | no | `false` | Reclaims ~10 GiB. Runners have ~14 GiB free vs DO's builder's 24 GiB. |
| `poll_timeout_seconds` | no | `1800` | Terminal-phase poll budget. |

### Secrets

| Secret | Required | Notes |
|---|---|---|
| `DIGITALOCEAN_ACCESS_TOKEN` | yes | Must carry **container-registry read+write** *and* App Platform update on the same team. Registry scope is **not** implied by `app:update`. |
| `DO_APP_ID` | yes | Passed as a secret, not an input: the `secrets` context is unavailable in a caller's `jobs.<id>.with` block, and every consumer stores the app ID as a repo secret. |
| `BUILD_SECRET_VALUE` | no | Value for `build_secret_id`. |

The caller must grant `contents: read` and `deployments: write` — a reusable
workflow can only narrow the token.

### How it degrades

A token that cannot obtain read-write registry credentials makes the whole run a
**loud green no-op**: nothing is built, nothing pushed, nothing patched, and the
log names the exact operator action. That is deliberate — the credential is the
second arming mechanism, so this file can be merged and observed for weeks
before it can touch anything. The interlock that makes every failure path a
no-op rather than a *partial* action is the "Verify the image tag exists in
DOCR" step: the spec is never pointed at a tag that is not provably present.

### Rollback

```bash
# find the last good tag, then:
gh workflow run deploy-staging.yml -f ref=<last-good-sha> -f promote_only=true
```

No rebuild, no DO console, and nothing can silently overwrite it: once promoted
this way the app has no git source, so there is no `deploy_on_push` to clobber
the rollback on the next merge.

### Tagging and registry growth

One immutable tag per build — the full commit SHA — plus a single moving
`:buildcache` tag. No `latest`, nothing moving that could make "what is running"
ambiguous; the live spec's `image.tag` is the record.

The build cache is `mode=max` deliberately: these Dockerfiles are multi-stage
and every expensive layer (`bundle install`, `npm ci`, `assets:precompile`)
lives in a stage discarded from the final image, so `mode=min` would export none
of them and leave a 2 vCPU runner doing a cold build on every push. The
consequence is that superseded cache manifests orphan blobs in the registry.
Those are reclaimed by **DOCR garbage collection**, which is what to schedule —
deleting *tags* does not touch them. Treat that as registry legibility and tag
hygiene; storage overage is $0.02/GiB and is not the reason.

## Versioning

The `v2` tag is a moving major-version pointer. Backwards-compatible changes
land on `v2`; breaking input changes will publish under `v3`. Pin to a SHA if
you need stricter immutability.
