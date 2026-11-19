#!/usr/bin/env node
// run.mjs — the /release skill eval: the COLLECT stage.
//
// For each scenario × trial it builds a sandbox (world.mjs: a fake app's bare
// origin with `main` and `production`, stub gh/curl/doctl/sentry-cli answering for
// the scenario), runs `/release` headless over the scenario's scripted turns, and
// records the transcript and every stub call. score.mjs grades the records.
//
// Nothing can deploy: there is no GitHub here. `gh workflow run` lands in the
// stub's log; `git push` lands in the sandbox's bare origin (logged); health URLs
// are `.invalid` hosts answered by the curl stub. See ../runner/README.md for the
// isolation.
//
// Usage:
//   node evals/skills/release/run.mjs --scenarios red-ci,dry-run-go --n 1 \
//     --out evals/skills/release/results/<date>-local.runs.jsonl
// Flags: --scenarios a,b (default all)  --n 3  --model M  --effort E
//        --skill <SKILL.md> (default skills/release/SKILL.md in this checkout)
//        --work-root DIR  --claude-bin claude  --timeout-s 1200
//        --max-run-usd 3  --max-total-usd 10  --fresh-config  --keep  --resume
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { git, installStub, makeSandbox, RUNNER_FILES, sh } from "../runner/sandbox.mjs";
import { commonFlags, runTrials, skillModel } from "../runner/driver.mjs";
import { buildSeed, REPO, SCENARIOS, TURNS, worldFor } from "./world.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

export function setupRun({ skillPath }) {
  return ({ runRoot }) => {
    const skillText = fs.readFileSync(skillPath, "utf8");
    const { seed, shas } = buildSeed({ runRoot, skillText });
    let blob = null;
    try { blob = sh("git", ["hash-object", skillPath]); } catch { /* not in a repo */ }
    return { seed, shas, record: { skill_path: path.relative(ROOT, skillPath), skill_blob: blob, skill_sha256: crypto.createHash("sha256").update(skillText).digest("hex").slice(0, 16) } };
  };
}

export function setupTrial({ runCtx, runRoot, keys, scenario }) {
  const s = makeSandbox({ runRoot, keys, seed: runCtx.seed, repo: REPO });
  const w = worldFor(scenario, { shas: runCtx.shas, bare: s.bare });
  git(s.bare, "update-ref", "refs/heads/production", w.facts.production);
  if (w.facts.production === w.facts.target) {
    const tag = w.world.releases[0].tagName;
    git(s.bare, "update-ref", `refs/tags/${tag}`, w.facts.target);
  }
  fs.writeFileSync(path.join(s.state, "world.json"), JSON.stringify(w.world, null, 2));
  fs.writeFileSync(path.join(s.state, "http.json"), JSON.stringify(w.http, null, 2));
  fs.writeFileSync(path.join(s.state, "canned.json"), JSON.stringify(w.canned, null, 2));
  const files = { ...RUNNER_FILES, "release/gh-stub.mjs": path.join(HERE, "gh-stub.mjs") };
  installStub({ bin: s.bin, state: s.state, name: "gh", entry: "release/gh-stub.mjs", files });
  installStub({ bin: s.bin, state: s.state, name: "curl", entry: "runner/http-stub.mjs", files, extra: ["--name", "curl"] });
  for (const tool of Object.keys(w.canned)) installStub({ bin: s.bin, state: s.state, name: tool, entry: "runner/canned-stub.mjs", files, extra: ["--name", tool] });

  // The agent's checkout: origin is the app's github.com URL, which the sandbox
  // gitconfig rewrites to the bare repo, so `git remote -v` looks real.
  const cwd = path.join(s.sandbox, "harbor-web");
  sh("git", ["clone", "-q", "--branch", "main", `https://github.com/${REPO}.git`, cwd], { env: s.gitEnv });
  const refsBefore = git(s.bare, "for-each-ref", "--format=%(refname) %(objectname)");

  return {
    ...s, cwd, turns: TURNS[scenario],
    collect: () => ({
      world: w.facts,
      refs_before: refsBefore.split("\n"),
      refs_after: git(s.bare, "for-each-ref", "--format=%(refname) %(objectname)").split("\n"),
      dispatched_runs: (fs.existsSync(path.join(s.state, "gh-state.json")) ? JSON.parse(fs.readFileSync(path.join(s.state, "gh-state.json"), "utf8")).runs : [])
        .map((r) => ({ id: r.databaseId, workflow: r.workflow, inputs: r.inputs, createdAt: r.createdAt })),
    }),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const skillPath = path.resolve((() => { const i = argv.indexOf("--skill"); return i >= 0 ? argv[i + 1] : path.join(ROOT, "skills", "release", "SKILL.md"); })());
  // Evaluate on the model the skill runs on in production (its frontmatter says
  // `model: opus`), unless --model or $CLAUDE_MODEL overrides it.
  const f = commonFlags(argv, { name: "release-eval", scenarios: SCENARIOS, timeoutS: 1200, maxRunUsd: 3, maxTotalUsd: 10,
    model: skillModel(fs.readFileSync(skillPath, "utf8")),
    out: path.join(HERE, "results", `${new Date().toISOString().slice(0, 10)}-local.runs.jsonl`) });
  console.error(`model: ${f.model} (${f.model_source})`);
  process.exitCode = await runTrials({
    ...f, name: "release", allScenarios: SCENARIOS,
    setupRun: setupRun({ skillPath }), setupTrial,
    summarize: (rec) => `dispatches=${rec.gh.filter((c) => c.dispatch).length} forbidden=${rec.gh.filter((c) => c.forbidden).length}`,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
