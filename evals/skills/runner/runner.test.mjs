// Unit tests for the shared skill-eval runner. No claude, no network.
// Run: node --test evals/skills/runner/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./sandbox.mjs";
import { ACCOUNT_LIMIT, accountLimit, claudeArgs, parseStream, runSession, sessionTotals, userMessage } from "./session.mjs";
import { executable, runScoreCli, selfTest, stubBypassed } from "./grade.mjs";
import { curlAnswer } from "./http-stub.mjs";
import { cannedAnswer } from "./canned-stub.mjs";
import { fieldsOf, parseArgs } from "./stub-core.mjs";
import { resolveModel, skillModel } from "./driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skill-eval-test-"));

// ---- session -------------------------------------------------------------------------

test("claudeArgs isolates the session and forbids asking a human through a tool", () => {
  const a = claudeArgs({ model: "m", effort: "high", maxRunUsd: 2 });
  for (const f of ["-p", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "--max-budget-usd"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "project");
  assert.deepEqual(a[a.indexOf("--disallowedTools") + 1].split(","), ["WebFetch", "WebSearch", "AskUserQuestion"]);
  assert.equal(a[a.indexOf("--max-budget-usd") + 1], "2");
});

test("parseStream splits text and tool calls by turn", () => {
  const ev = (o) => JSON.stringify(o);
  const out = [
    ev({ type: "system", subtype: "init", model: "x", claude_code_version: "9", skills: ["release"] }),
    ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh run list /sb/x" } }] } }),
    ev({ type: "assistant", message: { content: [{ type: "text", text: "Recommendation: Hold" }] } }),
    ev({ type: "result", result: "Recommendation: Hold", total_cost_usd: 0.1, num_turns: 2, duration_ms: 5, modelUsage: { a: {} } }),
    "not json",
    ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "release" } }, { type: "text", text: "done" }] } }),
    ev({ type: "result", result: "done", total_cost_usd: 0.3, num_turns: 4, duration_ms: 7, modelUsage: { b: {} } }),
  ].join("\n");
  const p = parseStream(out, (s) => s.replaceAll("/sb", "$SANDBOX"));
  assert.equal(p.results.length, 2);
  assert.deepEqual(p.texts, ["Recommendation: Hold", "done"]);
  assert.deepEqual(p.trace.map((s) => [s.turn, s.tool]), [[1, "Bash"], [2, "Skill"]]);
  assert.equal(p.trace[0].command, "gh run list $SANDBOX/x");
  assert.deepEqual(p.init.skills, ["release"]);
  const t = sessionTotals(p.results);
  assert.equal(t.total_cost_usd, 0.3); // cumulative: the last result carries the session total
  assert.equal(t.duration_ms, 12);
  assert.deepEqual(t.models_used, ["a", "b"]);
  assert.equal(t.error, null);
  assert.match(sessionTotals([{ is_error: true, subtype: "error_max_budget_usd" }]).error, /max_budget/);
});

test("userMessage is one stream-json user line", () => {
  const m = JSON.parse(userMessage("/release"));
  assert.equal(m.type, "user");
  assert.equal(m.message.content[0].text, "/release");
});

test("runSession sends the next turn only after the previous turn's result, and bumps the turn first", async () => {
  const dir = tmp();
  const script = path.join(dir, "s.json");
  fs.writeFileSync(script, JSON.stringify({ turns: [{ bash: ["echo one"], text: "first" }, { bash: [], text: "second" }] }));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_SCRIPT=${script} exec "${process.execPath}" "${path.join(HERE, "fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  const turns = [];
  const r = await runSession({ bin, args: ["-p"], cwd: dir, env: process.env, turns: ["a", "b"], timeoutS: 30, onTurn: (k) => turns.push(k) });
  assert.deepEqual(turns, [1, 2]);
  assert.equal(r.turns_sent, 2);
  const p = parseStream(r.out);
  assert.deepEqual(p.results.map((x) => x.result), ["first", "second"]);
  assert.deepEqual(p.trace.map((s) => s.turn), [1]);
});

// ---- environment ---------------------------------------------------------------------

test("childEnv keeps only the model credential: no GitHub, SSH or real HOME", () => {
  const env = childEnv({ HOME: "/home/u", PATH: "/usr/bin", GH_TOKEN: "x", GITHUB_TOKEN: "x", SSH_AUTH_SOCK: "/s", DEVCONTAINER_REMOTE_HOST: "h", CLAUDE_CODE_OAUTH_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "k" }, { sandbox: "/sb" });
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "DEVCONTAINER_REMOTE_HOST", "AWS_SECRET_ACCESS_KEY"]) assert.equal(env[k], undefined, k);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "t");
  assert.equal(env.HOME, "/sb/home"); // no user rc file can reorder PATH ahead of the stubs
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/u/.claude");
  assert.ok(env.PATH.startsWith("/sb/bin:"));
  assert.equal(env.GH_CONFIG_DIR, "/sb/gh-config");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/sb/gitconfig");
  assert.equal(childEnv({ HOME: "/home/u", PATH: "/p" }, { sandbox: "/sb", freshConfig: true }).CLAUDE_CONFIG_DIR, "/sb/claude-config");
});

// ---- stubs ---------------------------------------------------------------------------

test("parseArgs and fieldsOf read gh-style flags", () => {
  const a = parseArgs(["workflow", "run", "x.yml", "--ref", "main", "-f", "ref=abc", "-f", "dry_run=true", "--json=a,b"], new Set(["--ref", "-f", "--json"]));
  assert.deepEqual(a.pos, ["workflow", "run", "x.yml"]);
  assert.equal(a.get("--ref"), "main");
  assert.deepEqual(fieldsOf(a.all("-f")), { ref: "abc", dry_run: "true" });
  assert.equal(a.get("--json"), "a,b");
});

test("the curl stub models the options health checks use", () => {
  const routes = { "https://ok.invalid/h": { status: 200, body: '{"status":"ok"}' }, "https://down.invalid/h": { status: 503, body: "no" } };
  assert.deepEqual([curlAnswer(routes, ["-fsS", "--max-time", "10", "https://ok.invalid/h"]).out, curlAnswer(routes, ["-fsS", "https://ok.invalid/h"]).exit], ['{"status":"ok"}', 0]);
  assert.equal(curlAnswer(routes, ["-s", "-o", "/dev/null", "-w", "%{http_code}", "https://ok.invalid/h"]).out, "200");
  assert.equal(curlAnswer(routes, ["-so", "/dev/null", "-w", "%{http_code}\\n", "https://down.invalid/h"]).out, "503\n");
  assert.equal(curlAnswer(routes, ["-fsS", "https://down.invalid/h"]).exit, 22);
  assert.match(curlAnswer(routes, ["-i", "https://ok.invalid/h"]).out, /^HTTP\/2 200 OK\r\n[\s\S]*\r\n\r\n\{"status":"ok"\}$/);
  const miss = curlAnswer(routes, ["-sS", "https://app.example.com/"]);
  assert.equal(miss.exit, 6);
  assert.match(miss.err, /Could not resolve host: app\.example\.com/);
  assert.equal(curlAnswer(routes, ["-s", "https://nope.invalid/"]).err, ""); // -s without -S is silent
});

test("the canned stub answers the first matching rule, else its default, else 127", () => {
  const cfg = { d: { rules: [{ match: "^apps list", out: "[]" }], default: { exit: 1, err: "no" } } };
  assert.deepEqual(cannedAnswer(cfg, "d", ["apps", "list", "-o", "json"]), { exit: 0, out: "[]", err: "", matched: "^apps list" });
  assert.equal(cannedAnswer(cfg, "d", ["account", "get"]).exit, 1);
  assert.equal(cannedAnswer(cfg, "other", []).exit, 127);
});

// ---- grading -------------------------------------------------------------------------

test("executable() drops heredoc bodies and quoted messages", () => {
  assert.equal(executable("cat <<'EOF'\ngh workflow run x\nEOF"), "cat <<HEREDOC");
  assert.equal(executable('git commit -m "gh workflow run x"'), "git commit -m MSG");
  assert.equal(executable("gh workflow run x -f a=b"), "gh workflow run x -f a=b");
});

test("stubBypassed flags gh commands that never reached the stub", () => {
  const rec = { trace: [{ turn: 1, tool: "Bash", command: "cd x && gh run list" }], gh: [] };
  assert.match(stubBypassed(rec), /1 gh command/);
  assert.equal(stubBypassed({ ...rec, gh: [{ args: ["run", "list"] }] }), null);
  assert.equal(stubBypassed({ trace: [{ tool: "Bash", command: "echo high" }], gh: [] }), null);
});

test("runScoreCli exit codes: 0 pass, 2 rubric failure, 3 INVALID control, 4 errored, 1 usage", () => {
  const dir = tmp();
  const write = (name, recs) => { const f = path.join(dir, name); fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n"); return f; };
  const grade = (r) => ({ pass: !r.bad && !r.error, failed: r.bad ? ["x"] : r.error ? ["session_ok"] : [], checks: { x: { ok: !r.bad } }, warnings: [] });
  const control = { good: [{ scenario: "s" }], bad: [{ scenario: "s", id: "b", bad: true, expect_fail: "x" }] };
  const run = (argv, c = control) => runScoreCli({ argv, control: c, grade, scenarios: ["s"], write: () => {}, warn: () => {} });
  assert.equal(run(["--runs", write("ok.jsonl", [{ scenario: "s", trial: 1 }])]), 0);
  assert.equal(run(["--runs", write("bad.jsonl", [{ scenario: "s", trial: 1, bad: true }])]), 2);
  assert.equal(run(["--runs", write("bad2.jsonl", [{ scenario: "s", trial: 1, bad: true }]), "--allow-fail"]), 0);
  assert.equal(run(["--runs", write("err.jsonl", [{ scenario: "s", trial: 1, error: "boom" }])]), 4);
  assert.equal(run(["--runs", write("err2.jsonl", [{ scenario: "s", trial: 1, error: "boom" }]), "--allow-errors"]), 0);
  assert.equal(run(["--runs", write("ok2.jsonl", [{ scenario: "s", trial: 1 }])], { good: [{ scenario: "s" }], bad: [{ scenario: "s", id: "b", expect_fail: "x" }] }), 3);
  assert.equal(run([]), 1);
});

test("selfTest catches a grader that always passes or always fails", () => {
  const control = { good: [{ scenario: "s" }], bad: [{ scenario: "s", id: "b", expect_fail: "x" }] };
  assert.ok(selfTest({ control, grade: () => ({ pass: true, failed: [] }), scenarios: ["s"] }).some((f) => /PASSED/.test(f)));
  assert.ok(selfTest({ control, grade: () => ({ pass: false, failed: ["x"] }), scenarios: ["s"] }).some((f) => /known-good .* failed/.test(f)));
  assert.ok(selfTest({ control, grade: () => ({ pass: true, failed: [] }), scenarios: ["s", "t"] }).some((f) => /t: no known-good/.test(f)));
});

// ---- model ---------------------------------------------------------------------------

test("skillModel reads the frontmatter model and maps aliases to full ids", () => {
  assert.equal(skillModel("---\nname: x\nmodel: opus\n---\n# X"), "claude-opus-5-5");
  assert.equal(skillModel("---\nmodel: \"sonnet\"\n---\n"), "claude-sonnet-5-5");
  assert.equal(skillModel("---\nmodel: claude-haiku-5-5\n---\n"), "claude-haiku-5-5");
  assert.equal(skillModel("---\nmodel: inherit\n---\n"), null);
  assert.equal(skillModel("# no frontmatter\nmodel: opus\n"), null);
});

test("resolveModel: --model, then $CLAUDE_MODEL, then the skill's model, then sonnet", () => {
  assert.deepEqual(resolveModel(["--model", "m1"], { model: "s" }, { CLAUDE_MODEL: "e" }), { model: "m1", model_source: "flag" });
  assert.deepEqual(resolveModel([], { model: "s" }, { CLAUDE_MODEL: "e" }), { model: "e", model_source: "env" });
  assert.deepEqual(resolveModel([], { model: "s" }, {}), { model: "s", model_source: "skill-frontmatter" });
  assert.deepEqual(resolveModel([], {}, {}), { model: "sonnet", model_source: "default" });
});

test("an account limit is recognised and its text kept in the error", () => {
  const limited = [{ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets Nov 23, 7am (UTC)" }];
  assert.match(accountLimit(limited), /weekly limit/);
  assert.match(sessionTotals(limited).error, /^is_error: success: You've hit your weekly limit/);
  for (const t of ["You've reached your usage limit", "Claude usage limit reached", "You've hit your 5-hour limit"]) assert.ok(ACCOUNT_LIMIT.test(t), t);
  // Ordinary failures are not account limits: they must not stop the run.
  assert.equal(accountLimit([{ is_error: true, subtype: "error_max_budget_usd", result: "" }]), null);
  assert.equal(accountLimit([{ is_error: false, result: "the rate limit on this endpoint is 600/min" }]), null);
  assert.equal(accountLimit([{ is_error: true, subtype: "error_during_execution", result: "API rate limit exceeded for GitHub" }]), null);
});
