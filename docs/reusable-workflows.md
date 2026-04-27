# Reusable Workflows

This repo hosts reusable GitHub Actions workflows shared across rarebit-one
gems and apps. Consumers reference workflows here via:

```yaml
uses: rarebit-one/.github/.github/workflows/<name>.yml@v1
```

Pin to the `v1` tag (or a specific SHA) — `@main` works but does not give you
a stable contract.

## `reusable-gem-ci.yml`

Two-job CI workflow (`lint` + `test`) for Ruby gems. Replaces the per-gem
`.github/workflows/ci.yml` files.

### Inputs

| Input                | Type    | Required | Default                          | Description |
|----------------------|---------|----------|----------------------------------|-------------|
| `ruby-versions`      | string  | yes      | —                                | JSON array of Ruby versions for the test matrix, e.g. `'["4.0.0","4.0.3"]'`. |
| `lint-ruby-version`  | string  | no       | `"4.0.3"`                        | Ruby version used for the lint job. |
| `apt-packages`       | string  | no       | `""`                             | Space-separated apt packages installed before the test job. |
| `pre-test-commands`  | string  | no       | `""`                             | Multiline shell run before the test command (db setup, asset build). |
| `test-command`       | string  | no       | `bundle exec rspec`              | Command run by the test job. |
| `lint-command`       | string  | no       | `bundle exec rubocop -f github`  | Primary lint command. |
| `extra-lint-commands`| string  | no       | `""`                             | Multiline shell run after the primary lint command (brakeman, bundler-audit, etc.). |
| `upload-screenshots` | boolean | no       | `false`                          | When true, upload `tmp/screenshots/` as `screenshots-<ruby>` on test failure. |
| `concurrency-group`  | string  | no       | `""`                             | Override for the workflow concurrency group. Empty falls back to `<workflow>-<pr-or-ref>`. |

### Behavior

- Both jobs run on `ubuntu-latest`.
- `actions/checkout@v6`, `ruby/setup-ruby@v1` (with `bundler-cache: true`),
  `actions/upload-artifact@v7`.
- Test matrix has `fail-fast: false`.
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

## `reusable-gem-release.yml`

Two-job release workflow (`release` + `publish`) triggered on `v*` tags.
Validates the tag against the gemspec, extracts CHANGELOG notes, creates a
GitHub Release, and publishes to RubyGems via OIDC trusted publishing.

### Inputs

| Input            | Type   | Required | Default                          | Description |
|------------------|--------|----------|----------------------------------|-------------|
| `gem-name`       | string | yes      | —                                | Gem name (matches `spec.name`). Also used to derive the default version-file path. |
| `ruby-version`   | string | no       | `"4.0.3"`                        | Ruby used for verification and publish. |
| `version-file`   | string | no       | `lib/<gem-name>/version.rb` (with `-` → `/`) | Override the version file location. |
| `changelog-path` | string | no       | `CHANGELOG.md`                   | Path to the changelog file. |

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
