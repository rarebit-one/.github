// sandbox.mjs — the parts of a skill-eval sandbox every skill shares.
//
// A trial runs in its own directory under the run root. Nothing outside it is
// written, and the agent's environment is an allow-list, so it holds no GitHub,
// SSH or devcontainer credential, only its own model credential:
//
//   <sandbox>/bin/        stub CLIs (gh, curl, …) first on PATH, each a shell shim
//                         to a COPY of the stub module under bin/lib (the agent's
//                         PATH never points into the eval's own directory)
//   <sandbox>/state/      what the stubs keep and log: <name>-calls.jsonl, the
//                         current turn number, pushes.log, scenario config
//   <sandbox>/gitconfig   the agent's only git config (GIT_CONFIG_GLOBAL): an
//                         ephemeral ed25519 signing key and `insteadOf` rewrites
//                         that send the app's github.com remote to the sandbox's
//                         bare origin and every other github.com remote nowhere
//   <sandbox>/gh-config/  an empty GH_CONFIG_DIR, so a real `gh` is unauthenticated
//
// Ported from sidekick-web .claude/evals/ship/run.mjs (sidekick-labs/octo-brain#679).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// execFileSync returns null under `stdio: "inherit"`.
export const sh = (cmd, args, opts = {}) => (execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts }) ?? "").trim();
export const git = (dir, ...args) => sh("git", ["-C", dir, ...args]);

export const EVAL_EMAIL = "skill-eval@example.invalid";
export const EVAL_NAME = "Skill Eval";

// The only variables the agent inherits. Everything that could reach GitHub, an
// SSH agent, a devcontainer host or the operator's git setup is dropped.
const KEEP = /^(HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TZ|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_DEFAULT_(SONNET|OPUS|HAIKU|FABLE)_MODEL|CLAUDE_CODE_SUBAGENT_MODEL|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY)$/i;

// HOME is the sandbox's own empty home: the agent's Bash tool snapshots the
// user's shell rc files, and an rc that runs `mise activate` (or any PATH edit)
// would put the real, logged-in `gh` ahead of the stub. Without the real HOME
// there is no rc, no ~/.gitconfig and no ~/.config/gh to find. The CLI's own
// config dir stays reachable through CLAUDE_CONFIG_DIR (or the fresh one).
export function childEnv(env, { sandbox, freshConfig = false, extra = {} }) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => KEEP.test(k)));
  if (!freshConfig && !out.CLAUDE_CONFIG_DIR && env.HOME) out.CLAUDE_CONFIG_DIR = path.join(env.HOME, ".claude");
  out.HOME = path.join(sandbox, "home");
  out.PATH = `${path.join(sandbox, "bin")}:${env.PATH}`;
  out.GIT_CONFIG_GLOBAL = path.join(sandbox, "gitconfig");
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GH_CONFIG_DIR = path.join(sandbox, "gh-config");
  out.GH_PROMPT_DISABLED = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  if (freshConfig) out.CLAUDE_CONFIG_DIR = path.join(sandbox, "claude-config");
  return { ...out, ...extra };
}

export function ensureKey(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, "key");
  if (!fs.existsSync(key)) sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", EVAL_EMAIL, "-f", key]);
  const signers = path.join(dir, "allowed_signers");
  fs.writeFileSync(signers, `${EVAL_EMAIL} ${fs.readFileSync(key + ".pub", "utf8").trim()}\n`);
  return { key, signers };
}

// `repo` is "owner/name": every spelling of its github.com URL resolves to `bare`;
// any other github.com URL resolves to a directory that does not exist.
export function gitconfigText({ keys, bare, repo, blackhole }) {
  const forms = [`git@github.com:${repo}.git`, `https://github.com/${repo}.git`, `git@github.com:${repo}`, `https://github.com/${repo}`, `ssh://git@github.com/${repo}.git`];
  return `[user]
\tname = ${EVAL_NAME}
\temail = ${EVAL_EMAIL}
\tsigningkey = ${keys.key}
[gpg]
\tformat = ssh
[gpg "ssh"]
\tallowedSignersFile = ${keys.signers}
[commit]
\tgpgsign = true
[tag]
\tgpgsign = true
[init]
\tdefaultBranch = main
[url "${bare}"]
${forms.map((f) => `\tinsteadOf = ${f}`).join("\n")}
[url "${blackhole}/"]
\tinsteadOf = git@github.com:
\tinsteadOf = https://github.com/
\tinsteadOf = ssh://git@github.com/
`;
}

// A fresh trial directory with bin/, state/, gh-config/ and the gitconfig. The
// bare origin's post-receive hook logs every push to state/pushes.log.
export function makeSandbox({ runRoot, keys, seed, repo }) {
  const sandbox = fs.mkdtempSync(path.join(runRoot, "t-"));
  const state = path.join(sandbox, "state");
  const bin = path.join(sandbox, "bin");
  for (const d of [state, path.join(bin, "lib"), path.join(sandbox, "gh-config"), path.join(sandbox, "home")]) fs.mkdirSync(d, { recursive: true });
  const bare = path.join(sandbox, "origin.git");
  sh("git", ["clone", "-q", "--bare", seed, bare]);
  git(bare, "config", "gpg.ssh.allowedSignersFile", keys.signers);
  fs.writeFileSync(path.join(bare, "hooks", "post-receive"),
    `#!/bin/sh\nwhile read old new ref; do printf '%s %s %s %s\\n' "$old" "$new" "$ref" "$(date +%s)" >> "${state}/pushes.log"; done\n`, { mode: 0o755 });
  const blackhole = path.join(sandbox, "no-such-remote");
  const gitconfig = path.join(sandbox, "gitconfig");
  fs.writeFileSync(gitconfig, gitconfigText({ keys, bare, repo, blackhole }));
  setTurn(state, 1);
  return { sandbox, state, bin, bare, gitEnv: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" } };
}

// Installs a stub CLI as bin/<name>. `files` maps paths under bin/lib to source
// files, keeping the eval tree's layout (lib/runner/…, lib/<skill>/…) so the
// stubs' relative imports resolve; `entry` is the module to run, under bin/lib.
// The shim runs `node bin/lib/<entry> --state <state> [extra…] -- "$@"`.
export function installStub({ bin, state, name, entry, files, extra = [] }) {
  for (const [rel, src] of Object.entries(files)) {
    const dest = path.join(bin, "lib", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  }
  const q = (s) => `"${String(s).replaceAll('"', '\\"')}"`;
  fs.writeFileSync(path.join(bin, name),
    `#!/bin/sh\nexec ${q(process.execPath)} ${q(path.join(bin, "lib", entry))} --state ${q(state)} ${extra.map(q).join(" ")} -- "$@"\n`, { mode: 0o755 });
}

// The runner's own stub modules, for installStub's `files`.
export const RUNNER_FILES = Object.fromEntries(["stub-core.mjs", "sandbox.mjs", "canned-stub.mjs", "http-stub.mjs"]
  .map((f) => [`runner/${f}`, path.join(path.dirname(new URL(import.meta.url).pathname), f)]));

// The turn the agent is in. The session driver bumps it before each user message,
// and every stub stamps its log lines with it, so a grader can tell an action
// taken after a scripted "go" from one taken before.
export const setTurn = (state, n) => fs.writeFileSync(path.join(state, "turn"), String(n));
export function readTurn(state) {
  try { return Number(fs.readFileSync(path.join(state, "turn"), "utf8")) || 1; } catch { return 1; }
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function readPushes(state) {
  const f = path.join(state, "pushes.log");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
    const [old, sha, ref, ts] = l.split(" ");
    return { old, sha, ref, t: Number(ts) * 1000, deleted: /^0+$/.test(sha) };
  });
}

export const redactor = (pairs) => (s) => pairs.reduce((acc, [from, to]) => (from ? acc.replaceAll(from, to) : acc), String(s));
