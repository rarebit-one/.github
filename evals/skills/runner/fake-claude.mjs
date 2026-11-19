#!/usr/bin/env node
// fake-claude.mjs — a TEST DOUBLE for the Claude Code CLI, so the runner, the
// stubs and a skill's grader can be exercised end to end with no model, no
// network and no spend. Never used by a live run.
//
// It speaks the same protocol the runner drives: `--version`, and in -p mode
// stream-json user messages on stdin → stream-json events on stdout (an init
// event, then per turn: one assistant tool_use per scripted command, the command's
// output as a tool_result, the scripted assistant text, and a `result` event).
// Commands really run (`bash -c`, in the session's cwd and env), so the stubs log
// them exactly as they would a real agent's.
//
// The script is a JSON file named by FAKE_CLAUDE_SCRIPT:
//   { "turns": [ { "bash": ["cmd", …], "text": "briefing…" }, … ], "cost": 0.01 }
import fs from "node:fs";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

if (process.argv.includes("--version")) { process.stdout.write("0.0.0-fake (Claude Code)\n"); process.exit(0); }

const script = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
emit({ type: "system", subtype: "init", model: "fake-model", claude_code_version: "0.0.0-fake", permissionMode: "bypassPermissions", skills: script.skills || ["release"], plugins: [], mcp_servers: [] });

let turn = 0, id = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const step = script.turns[turn++] || { bash: [], text: "(no scripted turn)" };
  for (const cmd of step.bash || []) {
    const tid = `toolu_fake_${++id}`;
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: cmd } }] } });
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: process.env, cwd: process.cwd() });
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: (r.stdout || "") + (r.stderr || "") }] } });
  }
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: step.text || "" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: step.text || "", num_turns: turn * 3, duration_ms: 1000, total_cost_usd: (script.cost ?? 0.01) * turn, modelUsage: { "fake-model": {} }, usage: { input_tokens: 10, output_tokens: 10 } });
});
rl.on("close", () => process.exit(0));
