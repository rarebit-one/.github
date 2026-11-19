#!/usr/bin/env node
// canned-stub.mjs — a stand-in for any CLI whose answers a scenario can script
// (curl against health URLs, a doctl team wrapper, sentry-cli, …).
//
// The shim runs `canned-stub.mjs --state <dir> --name <tool> -- <argv…>`. The
// answers live in <state>/canned.json:
//
//   { "<tool>": { "rules": [ { "match": "<regex over argv joined by spaces>",
//                              "out": "...", "err": "...", "exit": 0 } ],
//                 "default": { "exit": 6, "err": "curl: (6) Could not resolve host\n" } } }
//
// The first matching rule answers. No rule and no default: exit 127, as if the
// tool were absent. Every call goes to <state>/tool-calls.jsonl with its turn.
import fs from "node:fs";
import path from "node:path";
import { Exit, runStubCli, isMain } from "./stub-core.mjs";

export function cannedAnswer(config, tool, args) {
  const spec = config[tool] || {};
  const line = args.join(" ");
  const rule = (spec.rules || []).find((r) => new RegExp(r.match).test(line));
  const hit = rule || spec.default || { exit: 127, err: `${tool}: command not found\n` };
  return { exit: hit.exit ?? 0, out: hit.out ?? "", err: hit.err ?? "", matched: rule ? rule.match : null };
}

export function cannedStub(args, ctx) {
  const config = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, "canned.json"), "utf8"));
  const a = cannedAnswer(config, ctx.name, args);
  ctx.meta.matched = a.matched;
  if (a.exit !== 0) throw new Exit(a.exit, a.out, a.err);
  if (a.err) process.stderr.write(a.err);
  return a.out;
}

if (isMain(import.meta.url)) runStubCli({ stub: cannedStub, log: "tool-calls.jsonl" });
