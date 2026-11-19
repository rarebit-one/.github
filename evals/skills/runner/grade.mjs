// grade.mjs — the GRADE helpers every skill eval shares: what a Bash command
// actually executes, the grader positive control, the per-scenario summary, the
// markdown report and the score CLI with its exit codes. Each skill supplies its
// own grade(record) → { pass, failed, checks, warnings } and its control file.
//
// Positive control (octo-brain check-positive-controls.md): before any number is
// printed, selfTest() grades the control: a known-good synthetic record per
// scenario that must pass, and known-bad ones that must each fail on the check
// named in their `expect_fail`. A broken control makes the run INVALID (exit 3).
//
// Exit codes of runScoreCli():
//   0 every trial passed   1 usage/IO   2 a trial FAILED (unless --allow-fail)
//   3 INVALID: the grader failed its positive control
//   4 a session errored (unless --allow-errors)
import fs from "node:fs";

// What a command EXECUTES: heredoc bodies and quoted message/title/body values are
// prose, so they're removed before any pattern is matched. ("I did not run `gh
// workflow run`" inside a commit message ran nothing.)
export function executable(cmd) {
  return String(cmd)
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, "<<HEREDOC")
    .replace(/(\s(?:-m|--message|-t|--title|-b|--body|--subject|--notes)\s+)("(?:[^"\\]|\\.)*"|'[^']*')/g, "$1MSG");
}

export const bashCommands = (rec, { turn } = {}) => (rec.trace || [])
  .filter((s) => s.tool === "Bash" && s.command && (turn == null || s.turn === turn))
  .map((s) => ({ turn: s.turn, cmd: executable(s.command) }));

// The instrument check: the trace ran `<tool> …` commands, yet the stub logged
// none of them, so the agent reached some other binary (a real, possibly
// credentialed one) and nothing it did was observed. Such a trial is void.
export function stubBypassed(rec, tool = "gh", log = rec.gh) {
  const re = new RegExp(`(^|[\\s;&|(\`])${tool}\\s+\\w`);
  const ran = bashCommands(rec).filter((x) => re.test(x.cmd)).length;
  return ran > 0 && !(log || []).length ? `${ran} ${tool} command(s) in the trace, none reached the stub` : null;
}

export function selfTest({ control, grade, scenarios }) {
  const failures = [];
  for (const s of scenarios) {
    if (!control.good.some((r) => r.scenario === s)) failures.push(`${s}: no known-good control`);
    if (!control.bad.some((r) => r.scenario === s)) failures.push(`${s}: no known-bad control`);
  }
  for (const r of control.good) {
    let g; try { g = grade(r); } catch (e) { failures.push(`known-good ${r.id || r.scenario} threw: ${e.message}`); continue; }
    if (!g.pass) failures.push(`known-good ${r.id || r.scenario} failed: ${g.failed.join(",")}`);
  }
  for (const r of control.bad) {
    let g; try { g = grade(r); } catch (e) { failures.push(`known-bad ${r.id} threw: ${e.message}`); continue; }
    if (g.pass) failures.push(`known-bad ${r.id} PASSED (it violates ${r.expect_fail})`);
    else if (!g.failed.includes(r.expect_fail)) failures.push(`known-bad ${r.id} failed on ${g.failed.join(",")}, not ${r.expect_fail}`);
  }
  return failures;
}

const median = (xs) => { const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

export function score(records, { control, grade, scenarios }) {
  const failures = selfTest({ control, grade, scenarios });
  if (failures.length) { const e = new Error(`INVALID: the grader failed its positive control — ${failures.join("; ")}`); e.code = "GRADER_INVALID"; throw e; }
  const graded = records.map((r) => ({ r, g: grade(r) }));
  const by = {};
  for (const { r, g } of graded) {
    const s = (by[r.scenario] ??= { trials: 0, passes: 0, errored: 0, failed_checks: {}, costs: [], durations: [], models: new Set(), cli: new Set(), warnings: [] });
    s.trials++;
    if (r.error) s.errored++;
    if (g.pass) s.passes++;
    for (const f of g.failed) s.failed_checks[f] = (s.failed_checks[f] || 0) + 1;
    s.costs.push(r.total_cost_usd); s.durations.push(r.duration_ms ?? r.wall_ms);
    for (const m of r.models_used || []) s.models.add(m);
    if (r.cli_version) s.cli.add(r.cli_version);
    s.warnings.push(...(g.warnings || []).map((w) => `#${r.trial}: ${w}`));
  }
  return {
    grader_self_test: "passed",
    trials: records.length, passes: graded.filter((x) => x.g.pass).length,
    errored: records.filter((r) => r.error).length,
    total_cost_usd: records.reduce((a, r) => a + (r.total_cost_usd || 0), 0),
    by_scenario: Object.fromEntries(Object.entries(by).map(([k, s]) => [k, {
      trials: s.trials, passes: s.passes, pass_rate: s.trials ? s.passes / s.trials : null, pass_all: s.passes === s.trials,
      errored: s.errored, failed_checks: s.failed_checks,
      median_cost_usd: median(s.costs), median_duration_s: median(s.durations) == null ? null : Math.round(median(s.durations) / 1000),
      models: [...s.models], cli_versions: [...s.cli], warnings: s.warnings,
    }])),
    trials_detail: graded.map(({ r, g }) => ({ scenario: r.scenario, trial: r.trial, pass: g.pass, failed: g.failed,
      model_requested: r.model_requested, models_used: r.models_used, cli_version: r.cli_version, skill_blob: r.skill_blob,
      total_cost_usd: r.total_cost_usd, duration_ms: r.duration_ms, num_turns: r.num_turns, error: r.error || null,
      checks: Object.fromEntries(Object.entries(g.checks).map(([n, c]) => [n, c.ok ? "ok" : `FAIL ${c.detail}`.trim()])), warnings: g.warnings })),
  };
}

export function render(res) {
  const rows = Object.entries(res.by_scenario).map(([s, v]) =>
    `| ${s} | ${v.passes}/${v.trials} | ${Object.entries(v.failed_checks).map(([k, n]) => `${k}×${n}`).join(", ") || "–"} | ${v.median_cost_usd == null ? "–" : "$" + v.median_cost_usd.toFixed(2)} | ${v.median_duration_s ?? "–"}s | ${v.models.join(", ")} | ${v.cli_versions.join(", ")} |`);
  const fails = res.trials_detail.filter((t) => !t.pass).map((t) => `- ${t.scenario} #${t.trial}: ${Object.entries(t.checks).filter(([, c]) => c !== "ok").map(([n, c]) => `${n} (${c.replace(/^FAIL\s*/, "") || "-"})`).join("; ")}`);
  const warn = Object.entries(res.by_scenario).flatMap(([s, v]) => v.warnings.map((w) => `- ${s} ${w}`));
  return [
    `Grader self-test: ${res.grader_self_test}. ${res.passes}/${res.trials} trials passed; ${res.errored} errored; $${res.total_cost_usd.toFixed(2)} API-equivalent.`, "",
    "| scenario | pass | failed checks | median cost | median time | models | CLI |",
    "|---|---|---|---|---|---|---|", ...rows,
    ...(fails.length ? ["", "Failed trials:", ...fails] : []),
    ...(warn.length ? ["", "Warnings:", ...warn] : []), "",
  ].join("\n");
}

const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Returns the exit code; the caller sets process.exitCode.
export function runScoreCli({ argv = process.argv.slice(2), control, grade, scenarios, write = (s) => process.stdout.write(s), warn = (s) => console.error(s) }) {
  const i = argv.indexOf("--runs");
  if (i < 0 || !argv[i + 1]) { warn("usage: score.mjs --runs <runs.jsonl>[,more] [--json] [--allow-errors] [--allow-fail]"); return 1; }
  let res;
  try {
    const c = typeof control === "function" ? control() : control;
    res = score(argv[i + 1].split(",").flatMap(readJsonl), { control: c, grade, scenarios });
  } catch (e) {
    warn(e.message);
    return e.code === "GRADER_INVALID" ? 3 : 1;
  }
  write(argv.includes("--json") ? JSON.stringify(res, null, 2) + "\n" : render(res));
  if (res.errored && !argv.includes("--allow-errors")) { warn(`FAIL LOUD: ${res.errored} errored session(s)`); return 4; }
  // An errored session (spend cap, timeout) is infrastructure, reported by exit 4;
  // exit 2 is for sessions that ran and broke the rubric.
  const failed = res.trials_detail.filter((t) => !t.pass && !t.error).length;
  if (failed && !argv.includes("--allow-fail")) { warn(`FAIL: ${failed} of ${res.trials} trial(s) broke the rubric`); return 2; }
  return 0;
}
