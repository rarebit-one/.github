// stub-core.mjs — shared plumbing for the stub CLIs a skill eval puts on PATH.
//
// A stub is a function (args, ctx) → stdout string, which throws Exit for a
// non-zero exit. runStubCli() wraps it as a CLI entry point: it parses
// `--state <dir> [--name <tool>] -- <argv…>`, runs the stub, and appends one line
// per call to <state>/<log>: the time, the agent's current turn, argv, exit code,
// output, whether the stub had to refuse the call as unsupported, and any `meta`
// the stub attached (e.g. `{ dispatch: {...} }`), which is what graders read.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readTurn } from "./sandbox.mjs";

export class Exit extends Error {
  constructor(code, out = "", err = "") { super(err || out); this.code = code; this.out = out; this.err = err; }
}
export const fail = (msg, code = 1) => { throw new Exit(code, "", msg.endsWith("\n") ? msg : msg + "\n"); };
export const UNSUPPORTED = "eval stub: unsupported";
export const unsupported = (what) => fail(`${UNSUPPORTED} ${what}`);

// gh-style argv parsing. `valued` names the flags that take a value; anything else
// starting with `-` is boolean. `--flag=value` always works.
export function parseArgs(argv, valued) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.includes("=")) { const [k, ...v] = a.split("="); (flags[k] ??= []).push(v.join("=")); continue; }
    if (valued.has(a)) { (flags[a] ??= []).push(argv[++i]); continue; }
    if (a.startsWith("-") && a !== "-") { (flags[a] ??= []).push(true); continue; }
    pos.push(a);
  }
  const get = (...ks) => { for (const k of ks) if (flags[k]) return flags[k][flags[k].length - 1]; return undefined; };
  const all = (...ks) => ks.flatMap((k) => flags[k] || []);
  return { pos, flags, get, all, has: (...ks) => ks.some((k) => flags[k]) };
}

// `k=v` pairs (gh's -f/-F/--field/--raw-field) as an object.
export const fieldsOf = (pairs) => Object.fromEntries(pairs.map((kv) => { const s = String(kv); const i = s.indexOf("="); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; }));

export function jq(value, expr, raw = true) {
  const r = spawnSync("jq", [raw ? "-r" : "-c", expr], { input: JSON.stringify(value), encoding: "utf8" });
  if (r.status !== 0) fail(`failed to parse jq expression: ${r.stderr.trim()}`);
  return r.stdout;
}

// gh's --json/--jq output: pick `fields` (when given), then apply --jq/-q.
export function emitJson(value, a, fields = null) {
  let v = value;
  if (fields) {
    const pick = (o) => Object.fromEntries(fields.map((f) => [f, o[f] ?? null]));
    v = Array.isArray(value) ? value.map(pick) : pick(value);
  }
  const expr = a.get("--jq", "-q");
  return expr ? jq(v, expr) : JSON.stringify(v, null, 2) + "\n";
}

export function runStubCli({ argv = process.argv.slice(2), stub, log }) {
  const sep = argv.indexOf("--");
  const head = sep < 0 ? argv : argv.slice(0, sep);
  const stateDir = head[head.indexOf("--state") + 1];
  const name = head.includes("--name") ? head[head.indexOf("--name") + 1] : undefined;
  const args = sep < 0 ? [] : argv.slice(sep + 1);
  const t = Date.now();
  const ctx = { stateDir, name, meta: {} };
  let code = 0, out = "", err = "";
  try { out = stub(args, ctx) ?? ""; }
  catch (e) { if (e instanceof Exit) { code = e.code; out = e.out; err = e.err; } else { code = 1; err = `eval stub crashed: ${e.stack || e}\n`; } }
  const line = { t, turn: readTurn(stateDir), ...(name ? { tool: name } : {}), args, exit: code, unsupported: err.includes(UNSUPPORTED), out: out.slice(0, 1500), err: err.slice(0, 500), ...ctx.meta };
  fs.appendFileSync(path.join(stateDir, log), JSON.stringify(line) + "\n");
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}

export const isMain = (metaUrl) => !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(metaUrl).pathname);
