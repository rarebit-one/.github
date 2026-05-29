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
- **`reusable-sentry-autofix.yml`** — daily Sentry-issue triage with optional
  auto-fix PRs (the apply step mirrors the post-deploy autofix safety model
  developed in sidekick-labs).

## Claude model selection

Every workflow that invokes `anthropics/claude-code-action` (`claude-agent`,
`claude-code-review`, `reusable-weekly-maintenance`, `reusable-sentry-autofix`)
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
    uses: rarebit-one/.github/.github/workflows/reusable-gem-release.yml@v1
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
    uses: rarebit-one/.github/.github/workflows/reusable-gem-release.yml@v1
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
| `linear-fallback` | boolean | no | `false` | When true, Claude opens a Linear issue for risky/judgment-call items. Requires `linear-api-key` secret. |
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
| `linear-api-key` | no | Required only when `linear-fallback: true`. |

### Behavior

- Top-level `permissions: {}`; the job re-grants `contents: write`,
  `pull-requests: write`, `id-token: write` for the signed-commit + PR flow,
  plus `security-events: read`. The read scope is always granted (Actions has a
  static permissions model) but is only exercised when `review-security-alerts:
  true`; it is never `write`, so the workflow can never dismiss alerts.
- All third-party actions are SHA-pinned (checkout, ruby/setup-ruby,
  setup-node, anthropics/claude-code-action). KMP-only setup-java and
  setup-gradle remain on floating major tags pending org-wide pinning.
- Linear MCP server is always declared but only consulted when
  `linear-fallback: true` (Claude only authorises the `mcp__linear__*` tools
  in that mode).
- TODO/FIXME census uses `actions/cache` to keep the previous run's snapshot
  scoped per `repository_id`; week-over-week delta surfaces in `$GITHUB_STEP_SUMMARY`
  and in the PR body.

### Example — Rails app (luminality-web, fundbright-web, nutripod-web)

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  id-token: write
  security-events: read

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v2
    with:
      stack: rails
      run-brakeman: true
      run-sorbet-rbi: true
      linear-fallback: true
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
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
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
  id-token: write
  security-events: read

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v2
    with:
      stack: ruby-gem
      ruby-version: '4.0.3'
      linear-fallback: true
      lint-commands: |
        bundle exec rubocop
      test-commands: |
        bundle exec rspec
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

### Example — Node library (luminality-ui)

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  id-token: write
  security-events: read

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v2
    with:
      stack: node-lib
      node-version: '20'
      linear-fallback: true
      lint-commands: |
        npm run lint
        npm run check
      test-commands: |
        npm run test:run
        npm run build
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

### Example — Kotlin Multiplatform (luminality-app)

```yaml
name: Weekly Maintenance
on:
  schedule:
    - cron: '0 0 * * 0'
  workflow_dispatch:

permissions: {}

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v1
    with:
      stack: kmp
      jdk-version: '17'
      linear-fallback: true
      gradle-test-command: ./gradlew :composeApp:testDebugUnitTest
      additional-allowed-tools: 'Bash(./gradlew :composeApp:testDebugUnitTest:*)'
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

## `reusable-sentry-autofix.yml`

Daily (or webhook-triggered) Sentry sweep. Picks the top unresolved Sentry
issue for the project that does NOT already have an open or recently-closed
auto-fix PR, hands it to Claude for triage, and — when the verdict is
high-confidence — opens a draft PR with a minimal forward-fix. Validation
mirrors the post-deploy-triage autofix composite: hard path blocklist
(migrations, workflows, `config/credentials*`, `config/master.key`, lockfiles)
plus a 50-line diff cap. Never merges. Always opens a draft for human review.

The fetch step queries Sentry for the project's top issues, then dedups against
auto-fix PRs by matching the HTML marker `<!-- sentry-autofix: <SHORT_ID> -->`
in PR bodies (open + closed within `dedup-window-days`). That same marker is
stamped into every autofix PR opened by this workflow, closing the loop.

### Inputs

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `sentry-org` | string | no | `sidekick-labs` | Sentry organization slug. |
| `sentry-project` | string | yes | — | Sentry project slug (e.g. `luminality-web`). |
| `stack` | string | yes | — | One of `rails`, `ruby-gem`, `node-lib`, `node-app`, `kmp`. Drives toolchain setup for the apply step. |
| `mode` | string | no | `autofix` | `autofix` attempts a PR when triage is high-confidence; `triage-only` skips the apply step. `stack: kmp` always forces `triage-only`. |
| `max-candidates` | number | no | `10` | Top N Sentry issues considered before dedup filtering. Only ONE is triaged per run. |
| `issue-query` | string | no | `is:unresolved` | Sentry search query. Append modifiers (e.g. `is:unresolved level:error`) to narrow. |
| `ruby-version-file` | string | no | `.ruby-version` | Ruby version file (rails, ruby-gem stacks). |
| `ruby-version` | string | no | `""` | Explicit ruby-version override. |
| `node-version` | string | no | `lts/*` | Node version (rails, node-lib, node-app stacks). |
| `lint-commands` | string | no | `""` | Multiline lint commands run post-apply. All must exit 0 or the fix is rejected. Keep fast. |
| `test-commands` | string | no | `""` | Multiline test commands run post-apply. Use a focused subset, not the full suite — runs daily. |
| `linear-fallback` | boolean | no | `false` | When true, opens a Linear issue for triage-only runs and for autofix-skipped candidates. Requires `linear-api-key`. |
| `diff-line-cap` | number | no | `50` | Hard cap on total insertions+deletions in the apply diff. |
| `dedup-window-days` | number | no | `30` | How far back to scan closed PRs for the autofix marker. |
| `timeout-minutes` | number | no | `30` | Job-level timeout. |
| `claude-timeout-minutes` | number | no | `15` | Advisory — composite-action steps can't enforce this; job timeout is the hard bound. |
| `additional-allowed-tools` | string | no | `""` | Comma-separated entries appended to the apply step `--allowed-tools` (e.g. `Bash(bin/rspec:*)`). **Note:** entries are passed through unsanitised, and entries like `Bash(...)` widen Claude's blast radius beyond the default `Read,Edit,Grep,Glob`. Use sparingly and prefer tightly-scoped wildcards. |
| `release-bot-client-id` | string | no | `""` | GitHub App Client ID (or numeric App ID) for the bot that opens auto-fix PRs. Required together with `release-bot-private-key` to bypass the GITHUB_TOKEN event-suppression rule and trigger CI on bot-opened PRs. See "Setting up the auto-fix bot" below. When unset, the workflow falls back to GITHUB_TOKEN — the PR opens as a draft and CI must be triggered by a human nudge (close/reopen or `git push`). |

### Secrets

| Secret | Required | Description |
|---|---|---|
| `claude-code-oauth-token` | yes | OAuth token for `anthropics/claude-code-action`. |
| `sentry-api-token` | yes | **Read-scoped** Sentry token (`event:read` + `project:read`). NOT the deploy-release write token. See "Setting up `SENTRY_API_TOKEN`" below. |
| `linear-api-key` | no | Required only when `linear-fallback: true`. |
| `release-bot-private-key` | no | GitHub App private key (.pem contents). Required together with `release-bot-client-id` to bypass the GITHUB_TOKEN event-suppression rule. See "Setting up the auto-fix bot" below. |

### Triggers

Consumers typically schedule the workflow daily and also expose `workflow_dispatch`
for manual runs. `repository_dispatch` (with a `sentry-autofix` event type) is
the recommended hook for future Sentry-webhook integration once a relay sits
between Sentry's webhook output and GitHub's authenticated dispatch API.

### Example — Rails app (luminality-web)

```yaml
name: Sentry Autofix
on:
  schedule:
    - cron: '17 8 * * *'  # 08:17 UTC daily (off-hour to avoid GH cron stampede)
  workflow_dispatch:
  repository_dispatch:
    types: [sentry-autofix]

permissions: {}

jobs:
  sentry-autofix:
    uses: rarebit-one/.github/.github/workflows/reusable-sentry-autofix.yml@v2
    with:
      sentry-project: luminality-web
      stack: rails
      linear-fallback: true
      # Open auto-fix PRs as ready-for-review via the rarebit-release-bot
      # App so CI fires automatically. Without these two, the PR opens as
      # a draft and needs a human nudge.
      release-bot-client-id: ${{ vars.RELEASE_BOT_CLIENT_ID }}
      lint-commands: |
        bin/rubocop --force-exclusion
      test-commands: |
        bin/rspec --tag ~slow
      additional-allowed-tools: 'Bash(bin/rspec:*)'
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      sentry-api-token: ${{ secrets.SENTRY_API_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
      release-bot-private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
```

### Example — Node app (sidekick-harness)

```yaml
name: Sentry Autofix
on:
  schedule:
    - cron: '23 8 * * *'
  workflow_dispatch:
  repository_dispatch:
    types: [sentry-autofix]

permissions: {}

jobs:
  sentry-autofix:
    uses: rarebit-one/.github/.github/workflows/reusable-sentry-autofix.yml@v2
    with:
      sentry-project: luminality-web
      stack: node-app
      node-version: '24'
      linear-fallback: true
      # Open auto-fix PRs as ready-for-review via the rarebit-release-bot
      # App so CI fires automatically.
      release-bot-client-id: ${{ vars.RELEASE_BOT_CLIENT_ID }}
      lint-commands: |
        npm run lint
        npm run typecheck
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      sentry-api-token: ${{ secrets.SENTRY_API_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
      release-bot-private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
```

### Example — Ruby gem (sidekick-rdp-client)

```yaml
name: Sentry Autofix
on:
  schedule:
    - cron: '29 8 * * *'
  workflow_dispatch:
  repository_dispatch:
    types: [sentry-autofix]

permissions: {}

jobs:
  sentry-autofix:
    uses: rarebit-one/.github/.github/workflows/reusable-sentry-autofix.yml@v2
    with:
      sentry-project: nutripod-web
      stack: ruby-gem
      linear-fallback: true
      lint-commands: |
        bundle exec rubocop
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      sentry-api-token: ${{ secrets.SENTRY_API_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

### Example — KMP / Android (triage-only)

```yaml
name: Sentry Triage
on:
  schedule:
    - cron: '37 8 * * *'
  workflow_dispatch:
  repository_dispatch:
    types: [sentry-autofix]

permissions: {}

jobs:
  sentry-triage:
    uses: rarebit-one/.github/.github/workflows/reusable-sentry-autofix.yml@v2
    with:
      sentry-project: luminality-app
      # `stack: kmp` is accepted but no toolchain is installed — KMP is
      # triage-only in v1 (no autofix path), so the JDK/Gradle setup that
      # would be needed for an apply step is intentionally omitted.
      stack: kmp
      mode: triage-only
      linear-fallback: true
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      sentry-api-token: ${{ secrets.SENTRY_API_TOKEN }}
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
```

### Setting up the auto-fix bot

GitHub deliberately suppresses workflow runs for events caused by `GITHUB_TOKEN`
("anti-loop"). A bot-opened PR from the autofix workflow would therefore sit
with **zero CI checks** — no required-check status to satisfy, no path to merge
without a human pushing a commit or closing/reopening the PR.

The fix is to mint a short-lived **GitHub App installation token** instead of
using `GITHUB_TOKEN` for the push + PR open. Events caused by an App token
*do* fire downstream workflows.

The org already has a `rarebit-release-bot` App configured for the same
purpose in `promote-production.yml`. Reuse it:

1. **Install the App on each caller repo** that runs the autofix workflow.
   Visit https://github.com/apps/rarebit-release-bot/installations/select_target
   → pick `sidekick-labs` org → "Only select repositories" → add the repo.
2. **Set the App's Client ID as a repo variable** (it's not a secret — Client IDs
   are public). The variable name doesn't matter; the caller workflow passes
   its value as `release-bot-client-id`.
   ```bash
   # If you don't have the Client ID, copy from the App's General Settings page
   # at https://github.com/organizations/sidekick-labs/settings/apps/rarebit-release-bot
   gh variable set RELEASE_BOT_CLIENT_ID --repo sidekick-labs/<repo> --body '<numeric-id-or-Iv1-string>'
   ```
3. **Set the App's private key as a repo secret** (or, for less per-repo
   maintenance, an org-level secret with visibility restricted to the relevant
   repos).
   ```bash
   gh secret set RELEASE_BOT_PRIVATE_KEY --repo sidekick-labs/<repo> --body "$(cat path/to/rarebit-release-bot.pem)"
   ```
4. **Wire the caller** to pass both values to the reusable workflow:
   ```yaml
   with:
     # ...
     release-bot-client-id: ${{ vars.RELEASE_BOT_CLIENT_ID }}
   secrets:
     # ...
     release-bot-private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
   ```

When **either** input is missing, the workflow falls back to `GITHUB_TOKEN`
and opens the PR as a draft with a reviewer-checklist note explaining the
manual nudge needed.

### Setting up `SENTRY_API_TOKEN`

The org-level `SENTRY_AUTH_TOKEN` secret is scoped to `project:releases:write`
for the deploy / sentry-release workflows. Issue reads need a separate
read-only token.

1. Visit https://rarebit-one.sentry.io/settings/auth-tokens/
2. Create a **user auth token** (or, preferably, an **Internal Integration**
   under `/settings/developer-settings/new-internal/` for org-owned tokens
   that survive employee turnover).
3. Required scopes: `event:read`, `project:read`. Optional: `org:read` if you
   later want to query org-wide issue lists.
4. Add as a GitHub **organization secret** named `SENTRY_API_TOKEN`,
   visibility "All repositories" (or "Private repositories" matching the
   existing `SENTRY_AUTH_TOKEN`).
5. Verify with `gh secret list --org sidekick-labs`.

### Versioning

The `v2` tag bundles both reusable workflows. New input contracts will
land on `v2`; breaking changes will publish under `v3`. Pin to a SHA if
you need stricter immutability.

## Versioning

The `v2` tag is a moving major-version pointer. Backwards-compatible changes
land on `v2`; breaking input changes will publish under `v3`. Pin to a SHA if
you need stricter immutability.
