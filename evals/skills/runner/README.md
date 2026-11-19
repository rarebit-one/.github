# Skill-eval runner

Shared plumbing for evals of the estate's skills: each eval runs a skill headless
(`claude -p`) in a throwaway sandbox where stub CLIs stand in for GitHub,
production and the rest, then grades what the agent did from the stub call logs
and the transcript, deterministically. It is ported from an earlier `/ship` eval
in another org and kept skill-neutral, so `/release` (here) and other skills' evals,
including ones kept beside a skill in another repo, share one implementation.

| file | role |
|---|---|
| `sandbox.mjs` | per-trial sandbox: bare origin with a push log, signing key, gitconfig rewrites, the agent's allow-listed env, stub installation, the turn counter |
| `session.mjs` | one headless session over one or more scripted turns (stream-json in and out), and the transcript parser |
| `driver.mjs` | the COLLECT loop: scenario × trial, the cost cap, one JSONL record per trial |
| `stub-core.mjs` | shared stub plumbing: gh-style argv parsing, `--json`/`--jq`, the per-call log |
| `http-stub.mjs` | a `curl` that answers scripted URLs (status, body, `-f`, `-o`, `-w`, `-i`) and resolves nothing else |
| `canned-stub.mjs` | any other CLI (a doctl team wrapper, sentry-cli) answered by regex rules |
| `grade.mjs` | `executable()`, the positive control, the summary, the report and the score CLI's exit codes |
| `fake-claude.mjs` | a **test double** for the CLI: runs scripted Bash per turn, so the whole pipeline is tested with no model |
| `runner.test.mjs` | unit tests (`node --test`) |

## What a trial looks like

```
<work-root>/run-XXXX/
  seed.git                 built once per run by the skill's setupRun
  signing/                 an ed25519 key made for this run
  t-XXXX/                  one per trial, removed afterwards unless --keep
    origin.git             bare clone of the seed; post-receive logs pushes
    <app>/                 the agent's checkout (cwd); origin = the app's github.com URL
    bin/                   gh, curl, … shims → copies of the stub modules in bin/lib
    state/                 world.json, http.json, canned.json, turn,
                           gh-calls.jsonl, tool-calls.jsonl, pushes.log
    home/  gh-config/  gitconfig
```

## Isolation: nothing leaves the sandbox

- **The agent's environment is an allow-list** (`childEnv`): locale, the CLI's own
  model credential and proxy settings, nothing else. No `GH_TOKEN`/`GITHUB_TOKEN`,
  no `SSH_AUTH_SOCK`, no `DEVCONTAINER_REMOTE_HOST`. `GH_CONFIG_DIR` is empty, so even
  the real `gh` is unauthenticated, and `GIT_CONFIG_GLOBAL` is the sandbox's own.
- **`HOME` is the sandbox's empty `home/`.** Found while building this: the agent's
  Bash tool runs the user's shell rc, and an rc that runs `mise activate` puts the
  real `gh` ahead of the stub on `PATH`. The calls then miss the stub (and, with a
  real HOME, could reach a logged-in `gh`). With an empty HOME there is no rc to
  run. As a backstop, every grader should fail a trial whose trace ran `gh` while
  the stub logged nothing (`stubBypassed()`; the release eval's `stubs_reached`).
- **git**: the app's `github.com` URL in every spelling rewrites to the bare origin;
  every other `github.com` URL rewrites to a path that doesn't exist.
- **Health and other URLs** are `.invalid` hosts, answered only by the curl stub, so
  even a real curl reached by absolute path fails to resolve them.
- **Session isolation**: `--setting-sources project` (no user settings, hooks or
  plugins), `--strict-mcp-config` with no servers, `--no-session-persistence`, no
  WebFetch, WebSearch or AskUserQuestion (nobody can answer it; a skill must ask in
  text and end its turn), `--max-budget-usd` per trial. It runs with
  `--permission-mode bypassPermissions` because nobody can approve a prompt in `-p`
  mode. That is safe only because of the isolation above, which is why the live
  job is dispatch-only on a GitHub-hosted VM (see the workflow header).

## Turns

`runSession` drives `claude -p --input-format stream-json`. It sends the first
scripted message, waits for that turn's `result` event, bumps `state/turn`, sends
the next, and closes stdin after the last. Stubs stamp each log line with the
turn, so a grader can tell an action taken after a scripted "go" from one taken
before it. A single-turn scenario is just a one-element list.

## Adding a skill eval

A skill eval is a directory `evals/skills/<skill>/` with:

1. `run.mjs`: `setupRun({ runRoot, keys })` builds the seed (an app repo with the
   skill vendored at its real path) and returns `{ seed, record }`;
   `setupTrial(...)` calls `makeSandbox`, writes the scenario's state files, installs
   stubs with `installStub` (`RUNNER_FILES` plus the skill's own stub), clones the
   checkout and returns `{ …sandbox, cwd, turns, collect }`. `main()` passes both
   to `runTrials` with `commonFlags`.
2. a `gh` stub built on `stub-core.mjs` that tags production-affecting calls in
   `ctx.meta`, so the grader reads intent from the log rather than parsing argv.
3. `score.mjs`: `grade(record) → { pass, failed, checks, warnings }`, a
   `fixtures/grader-control.json` with a known-good and known-bad record per
   scenario, and `runScoreCli`.
4. `*.test.mjs`, including end-to-end runs through `runTrials` with
   `fake-claude.mjs`: a well-behaved scripted agent must pass every scenario, and a
   misbehaving one must fail the check it targets.
5. an entry in `.github/workflows/skill-eval.yml`'s `eval` choice and validation.

**From another repo** (for a skill whose source, and so whose transcripts, must stay
private): check out
`rarebit-one/.github` at a pinned SHA (it is public) and import
`<checkout>/evals/skills/runner/*.mjs` by absolute path. Nothing here resolves paths
relative to this repo's root. Keep that skill's world, stubs and grader in its own
repo next to the skill.

## Model

`commonFlags` picks the model as `--model`, then `$CLAUDE_MODEL`, then the model
the skill under test declares in its frontmatter (`skillModel()`: `opus` →
`claude-opus-5-5`, and so on), then the `sonnet` alias. A skill eval passes its
skill's model as `defaults.model`, so by default the eval runs on what production
runs on. Each record keeps `model_requested`, `model_source`, the init event's model
and the CLI's served `models_used`.

## Score CLI exit codes

`0` every trial passed · `1` usage/IO · `2` a trial broke the rubric (`--allow-fail`
reports only) · `3` INVALID: the grader failed its positive control · `4` a session
errored (`--allow-errors`) · and `run.mjs` exits `5` when the cost cap stopped it.
