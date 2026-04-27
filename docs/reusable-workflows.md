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

## Versioning

The `v1` tag is a moving major-version pointer. Backwards-compatible changes
land on `v1`; breaking input changes will publish under `v2`. Pin to a SHA if
you need stricter immutability.
