# Reusable Workflows

This repo hosts reusable GitHub Actions workflows shared across rarebit-one
gems and apps. Consumers reference workflows here via:

```yaml
uses: rarebit-one/.github/.github/workflows/<name>.yml@v1
```

Pin to the `v1` tag (or a specific SHA) — `@main` works but does not give you
a stable contract.

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
4. Hands off to `anthropics/claude-code-action` with a stack-aware prompt that
   runs the dependency updates, runs the verification commands you supply
   (`lint-commands`, `test-commands`, or `gradle-test-command`), and — only
   when verification passes — opens a signed PR via the GitHub API.
5. Uploads `tmp/maintenance/` (prompt, TODO/FIXME census + diff) as an
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

### Secrets

| Secret | Required | Description |
|---|---|---|
| `claude-code-oauth-token` | yes | OAuth token for `anthropics/claude-code-action`. |
| `linear-api-key` | no | Required only when `linear-fallback: true`. |

### Behavior

- Top-level `permissions: {}`; the job re-grants `contents: write`,
  `pull-requests: write`, `id-token: write` for the signed-commit + PR flow.
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

permissions: {}

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v1
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

permissions: {}

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v1
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

permissions: {}

jobs:
  maintenance:
    uses: rarebit-one/.github/.github/workflows/reusable-weekly-maintenance.yml@v1
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

## Versioning

The `v1` tag is a moving major-version pointer. Backwards-compatible changes
land on `v1`; breaking input changes will publish under `v2`. Pin to a SHA if
you need stricter immutability.
