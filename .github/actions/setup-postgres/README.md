# setup-postgres (root-free)

Stand up an ephemeral PostgreSQL in CI **without root, without a docker socket,
and without `apt`** — so it runs on the unprivileged `jumpdrive-broker` (`jdb`)
runners *and* on GitHub-hosted `ubuntu-latest`, unchanged.

## Why

`jdb` jobs execute inside an ephemeral **rootless-podman** container that is
deliberately locked down (`--security-opt no-new-privileges`, no docker API, no
`sudo`). The two usual ways to get a DB in CI both fail there:

| Approach | Needs | On `jdb` |
| --- | --- | --- |
| `services: postgres` container | docker/container API | ❌ absent |
| `sudo apt-get install postgresql` | root | ❌ absent |

This action instead runs postgres **entirely in user space**: it downloads a
relocatable postgres build (zonky
[`embedded-postgres-binaries`](https://github.com/zonkyio/embedded-postgres-binaries)
from Maven Central — per-OS/arch tarballs of a self-contained server), `initdb`s
a throwaway cluster under `$RUNNER_TEMP`, and `pg_ctl start`s it **as the normal
runner user**. PostgreSQL refuses to run as root, so the unprivileged user is not
a workaround — it is the supported configuration.

Verified end-to-end (download → sha1 → extract → `initdb` → start → real SQL
round-trip over `DATABASE_URL`) inside the actual `jumpdrive-ci-runner` image on
both **linux/amd64** and **linux/arm64** — PostgreSQL 16.15, uid 1000,
`no-new-privileges`, no sudo/docker. That jdb verification predates the 18
default; the 17 and 18 majors are smoke-tested on hosted `ubuntu-latest`
(`setup-postgres-smoke.yml`), and on jdb by the private consumer that pins them
(luminality-web: 17 for migration safety, 18 for the test suite). In this org
`jumpdrive-web` pins 16 and 18 (rarebit-one/jumpdrive-web#1131).

## Usage

```yaml
jobs:
  test:
    runs-on: [jdb, linux] # or ubuntu-latest — identical behaviour. Never a bare `jdb`:
                          # it can take a Mac runner minted for [jdb, macos] (luminalityai/delivery-ops#420)
    steps:
      - uses: actions/checkout@v4

      - uses: rarebit-one/.github/.github/actions/setup-postgres@main
        with:
          version: "17"   # pin your app's PRODUCTION major; defaults to 18

      # DATABASE_URL / PGHOST / PGPORT / PGUSER / PGDATABASE are now in the env
      - run: bundle exec rails db:prepare && bundle exec rspec
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `18` | PostgreSQL major. The default is the estate CI target (rarebit-one/rarebit-sre#376); pin your app's production major explicitly when prod is older. A bare major/`major.minor` resolves to the newest matching patch on Maven Central; an exact `X.Y.Z` is used as-is. |
| `port` | `5432` | TCP port to listen on (bound to `127.0.0.1`). |
| `database` | `postgres` | Database to ensure exists (created via the single-user backend if it isn't the default). |
| `username` | `postgres` | Superuser role the cluster is initialised with. |

## Outputs / exported env

The action writes these to `$GITHUB_ENV` (available to all later steps) and
exposes `database-url` as a step output:

- `DATABASE_URL` — `postgresql://<username>@127.0.0.1:<port>/<database>`
- `PGHOST=127.0.0.1`, `PGPORT`, `PGUSER`, `PGDATABASE`

## Notes & caveats

- **Auth is `trust`** on a throwaway, loopback-only cluster — correct for
  disposable CI, never for anything that outlives the job. No password is set;
  drivers that send one still connect (trust ignores it).
- **No client binaries.** zonky's linux tarballs ship only the server trio
  (`initdb` / `pg_ctl` / `postgres`) — no `psql` / `pg_isready` / `createdb`.
  Readiness uses `pg_ctl -w` plus a TCP probe; the extra database is created via
  the single-user backend. Your app connects through libpq / its own driver
  using `DATABASE_URL`, so no `psql` is needed on the runner.
- **Linux only** (amd64 / arm64) — the only architectures the runners use.
- This composite is **mirrored verbatim across the sibling org `.github` repos**
  (upstream copy: `luminalityai/.github`; also `sidekick-labs`, `fundbright`, `thesim-family`). Fix bugs
  **upstream first** and propagate, so every consumer switches with a one-line `uses:`
  change.
