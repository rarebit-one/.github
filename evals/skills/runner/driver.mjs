// driver.mjs — the COLLECT loop every skill eval shares: scenario × trial, one
// sandbox and one headless session per trial, one JSON record per trial appended
// to a JSONL file as it finishes. It authors no judgement; the skill's score.mjs
// grades the records.
//
// A skill eval supplies two hooks:
//   setupRun({ runRoot, keys })                     → runCtx (built once per run;
//       runCtx.record is merged into every record, e.g. the skill's blob sha)
//   setupTrial({ runCtx, runRoot, keys, scenario, trial })
//       → { sandbox, state, cwd, turns: [msg, …], collect(redact) → extra fields }
//
// Cost cap: no trial starts once spend so far plus --max-run-usd could pass
// --max-total-usd (exit 5). Spend is the CLI's API-equivalent `total_cost_usd`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv, ensureKey, readJsonl, readPushes, redactor, setTurn, sh } from "./sandbox.mjs";
import { claudeArgs, parseStream, runSession, sessionTotals } from "./session.mjs";

export function commonFlags(argv, defaults) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(n);
  return {
    opt, flag,
    scenarios: (opt("--scenarios") || defaults.scenarios.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    n: Number(opt("--n", 3)),
    model: opt("--model", process.env.CLAUDE_MODEL || defaults.model || "sonnet"),
    effort: opt("--effort", process.env.CLAUDE_EFFORT || ""),
    claudeBin: opt("--claude-bin", "claude"),
    timeoutS: Number(opt("--timeout-s", defaults.timeoutS ?? 1800)),
    maxRunUsd: Number(opt("--max-run-usd", defaults.maxRunUsd ?? 3)),
    maxTotalUsd: Number(opt("--max-total-usd", defaults.maxTotalUsd ?? 10)),
    freshConfig: flag("--fresh-config"),
    keep: flag("--keep"),
    resume: flag("--resume"),
    out: path.resolve(opt("--out", defaults.out)),
    workRoot: path.resolve(opt("--work-root", process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, defaults.name) : path.join(os.homedir(), ".cache", "skill-evals", defaults.name))),
  };
}

export async function runTrials(o) {
  for (const s of o.scenarios) if (!o.allScenarios.includes(s)) throw new Error(`unknown scenario ${s} (known: ${o.allScenarios.join(", ")})`);
  fs.mkdirSync(o.workRoot, { recursive: true });
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(o.workRoot, "run-"));
  const keys = ensureKey(path.join(runRoot, "signing"));
  const runCtx = await o.setupRun({ runRoot, keys });
  const cliVersion = sh(o.claudeBin, ["--version"]).split(" ")[0];
  const prior = o.resume ? readJsonl(o.out) : [];
  const done = new Set(prior.filter((r) => !r.error).map((r) => `${r.scenario}|${r.trial}|${r.model_requested}`));
  let spent = prior.reduce((a, r) => a + (r.total_cost_usd || 0), 0);
  let exit = 0;

  outer: for (const scenario of o.scenarios) {
    for (let trial = 1; trial <= o.n; trial++) {
      if (done.has(`${scenario}|${trial}|${o.model}`)) continue;
      if (spent + o.maxRunUsd > o.maxTotalUsd) { console.error(`STOP: spent $${spent.toFixed(2)}; another trial could pass --max-total-usd ${o.maxTotalUsd}`); exit = 5; break outer; }
      const t = await o.setupTrial({ runCtx, runRoot, keys, scenario, trial });
      const redact = redactor([[t.sandbox, "$SANDBOX"], [runRoot, "$RUN"], [os.homedir(), "~"]]);
      const env = childEnv(process.env, { sandbox: t.sandbox, freshConfig: o.freshConfig });
      if (o.freshConfig) fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
      const started = new Date().toISOString();
      console.error(`[${scenario} #${trial}] ${t.turns.length} turn(s) in ${redact(t.cwd)}`);
      const r = await runSession({ bin: o.claudeBin, cwd: t.cwd, env, turns: t.turns, timeoutS: o.timeoutS,
        args: claudeArgs({ model: o.model, effort: o.effort, maxRunUsd: o.maxRunUsd, pluginDir: t.pluginDir }),
        onTurn: (k) => setTurn(t.state, k) });
      const { results, texts, trace, init } = parseStream(r.out, redact);
      const totals = sessionTotals(results);
      const tail = redact(r.err).trim().slice(-400);
      const error = !results.length ? `no result event (exit ${r.code}${r.signal ? ", " + r.signal : ""}): ${tail}`
        : totals.error ? totals.error
        : results.length < t.turns.length ? `session ended after ${results.length} of ${t.turns.length} turns (exit ${r.code}${r.signal ? ", " + r.signal : ""}): ${tail}`
        : null;
      const scrub = (c) => ({ ...c, args: (c.args || []).map(redact), out: redact(c.out || "").slice(0, 600), err: redact(c.err || "").slice(0, 300) });
      const rec = {
        eval: o.name, scenario, trial, started, model_requested: o.model, effort: o.effort || null,
        model_aliases: Object.fromEntries(Object.entries(env).filter(([k]) => /^ANTHROPIC_DEFAULT_\w+_MODEL$|^CLAUDE_CODE_SUBAGENT_MODEL$/.test(k))),
        auth: env.ANTHROPIC_BASE_URL ? "gateway" : env.CLAUDE_CODE_OAUTH_TOKEN ? "oauth-token" : env.ANTHROPIC_API_KEY ? "api-key" : "cli-login",
        cli_version: init?.claude_code_version || cliVersion, init_model: init?.model ?? null,
        config_isolation: o.freshConfig ? "fresh-config-dir" : "setting-sources-project",
        ...totals, error, wall_ms: r.wall_ms, turns_scripted: t.turns.length, turns_sent: r.turns_sent,
        prompts: t.turns,
        results: results.map((x) => redact(x.result ?? "").slice(-4000)),
        texts: texts.map((x) => x.slice(-8000)),
        init, trace,
        gh: readJsonl(path.join(t.state, "gh-calls.jsonl")).map(scrub),
        tools: readJsonl(path.join(t.state, "tool-calls.jsonl")).map(scrub),
        pushes: readPushes(t.state),
        ...(runCtx.record || {}),
        ...(await t.collect(redact)),
      };
      fs.appendFileSync(o.out, JSON.stringify(rec) + "\n");
      spent += rec.total_cost_usd || 0;
      console.error(`[${scenario} #${trial}] ${(r.wall_ms / 1000).toFixed(0)}s $${(rec.total_cost_usd || 0).toFixed(2)} gh=${rec.gh.length} pushes=${rec.pushes.length}${o.summarize ? " " + o.summarize(rec) : ""}${error ? " ERROR " + error : ""}`);
      if (!o.keep) fs.rmSync(t.sandbox, { recursive: true, force: true });
    }
  }
  if (!o.keep) fs.rmSync(runRoot, { recursive: true, force: true });
  console.error(`done: $${spent.toFixed(2)} API-equivalent → ${o.out}`);
  return exit;
}
