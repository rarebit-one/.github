// session.mjs — one headless Claude Code session, possibly over several turns.
//
// The session runs `claude -p --input-format stream-json --output-format
// stream-json`, so a scenario can script a conversation: the first user message
// (usually the slash command), then, after each turn's `result` event, the next
// scripted message (e.g. the human's explicit "go"). Stdin closes after the last
// turn's result, and the CLI exits. Before each message the driver calls
// onTurn(k), which the runner uses to bump <state>/turn, so every stub log line
// says which turn it came from.
//
// Isolation (as in the earlier /ship and agent-navigation evals):
// `--setting-sources project` (no user settings, hooks or plugins),
// `--strict-mcp-config` with no MCP config, `--no-session-persistence`, no
// WebFetch/WebSearch, and no AskUserQuestion (a headless session has nobody to
// answer it, so a skill must ask in text and end its turn). The session runs with
// `--permission-mode bypassPermissions` because nobody can approve a prompt in
// -p mode; that is safe only because of the sandbox (sandbox.mjs).
import { spawn } from "node:child_process";

export const DISALLOWED = ["WebFetch", "WebSearch", "AskUserQuestion"];

export function claudeArgs({ model, effort, maxRunUsd, pluginDir, disallowed = DISALLOWED }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence",
    "--permission-mode", "bypassPermissions", "--disallowedTools", disallowed.join(","),
    "--max-budget-usd", String(maxRunUsd)];
  if (pluginDir) args.push("--plugin-dir", pluginDir);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

export const userMessage = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" }) + "\n";

// Pure, unit-tested. Turns the stream-json output into the per-turn `result`
// events, the init event's facts, each turn's assistant text, and the ordered
// TRACE of tool calls (Bash commands verbatim and capped, Skill names, file
// paths), each stamped with the turn it ran in. `redact` maps sandbox paths.
export function parseStream(text, redact = (s) => s) {
  const results = [], texts = [""], trace = [];
  let init = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const turn = results.length + 1;
    if (ev.type === "result") { results.push(ev); texts.push(""); }
    else if (ev.type === "system" && ev.subtype === "init" && !init) init = ev;
    else if (ev.type === "assistant") {
      for (const b of ev.message?.content || []) {
        if (b.type === "text" && b.text) texts[turn - 1] += (texts[turn - 1] ? "\n" : "") + redact(b.text);
        if (b.type !== "tool_use") continue;
        const i = b.input || {};
        const step = { turn, tool: b.name };
        if (b.name === "Bash" && typeof i.command === "string") step.command = redact(i.command).slice(0, 2000);
        if (b.name === "Skill") { step.skill = i.skill ?? i.command ?? i.name; if (i.args) step.args = String(i.args).slice(0, 200); }
        const p = i.file_path ?? i.path ?? i.notebook_path;
        if (typeof p === "string") step.path = redact(p);
        if (b.name === "Agent" || b.name === "Task") step.agent = String(i.description || i.subagent_type || "").slice(0, 120);
        trace.push(step);
      }
    }
  }
  if (texts.length > results.length && !texts[texts.length - 1]) texts.pop();
  return {
    results, texts, trace,
    init: init && { model: init.model, claude_code_version: init.claude_code_version, permissionMode: init.permissionMode,
      skills: init.skills || [], slash_commands: init.slash_commands || [],
      plugins: (init.plugins || []).map((p) => p.name ?? p), mcp_servers: (init.mcp_servers || []).map((m) => m.name ?? m) },
  };
}

// Totals over every turn's result event (cost and turns are cumulative per
// session in the CLI, so the LAST result carries the session total).
export function sessionTotals(results) {
  const last = results[results.length - 1] || {};
  return {
    total_cost_usd: last.total_cost_usd ?? null,
    num_turns: last.num_turns ?? null,
    duration_ms: results.reduce((a, r) => a + (r.duration_ms || 0), 0) || null,
    models_used: [...new Set(results.flatMap((r) => Object.keys(r.modelUsage || {})))],
    usage: last.usage ? { input_tokens: last.usage.input_tokens, output_tokens: last.usage.output_tokens, cache_read_input_tokens: last.usage.cache_read_input_tokens, cache_creation_input_tokens: last.usage.cache_creation_input_tokens } : null,
    error: errorOf(results),
  };
}

// The first error result, with its text: an account limit comes back as
// `subtype: "success", is_error: true` and the reason only in `result`.
function errorOf(results) {
  const e = results.find((r) => r.is_error);
  if (!e) return null;
  const text = String(e.result ?? "").trim().slice(0, 160);
  return `is_error: ${e.subtype || ""}${text ? `: ${text}` : ""}`;
}

// The CLI's message when the model account itself is out of quota, e.g.
// "You've hit your weekly limit · resets Nov 23, 7am (UTC)". Every later trial
// would fail the same way, so the driver stops instead of starting them.
export const ACCOUNT_LIMIT = /\b(hit|reached|exceeded) your (weekly |daily |monthly |session |5-hour |usage )?limit\b|\busage limit (reached|exceeded)\b/i;
export function accountLimit(results) {
  const e = results.find((r) => r.is_error && ACCOUNT_LIMIT.test(String(r.result ?? "")));
  return e ? String(e.result).trim().slice(0, 160) : null;
}

export function runSession({ bin, args, cwd, env, turns, timeoutS, onTurn = () => {} }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", buf = "", sent = 0, done = false;
    const send = () => { onTurn(sent + 1); child.stdin.write(userMessage(turns[sent])); sent++; };
    const finish = () => { if (!done) { done = true; child.stdin.end(); } };
    child.stdin.on("error", () => {}); // the CLI may exit before we close stdin
    child.stdout.on("data", (d) => {
      out += d; buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type !== "result" || done) continue;
        if (ev.is_error || sent >= turns.length) finish(); else send();
      }
    });
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutS * 1000);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err, wall_ms: Date.now() - t0, turns_sent: sent }); });
    send();
  });
}
