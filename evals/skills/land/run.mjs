#!/usr/bin/env node
// run.mjs — the /land skill eval: the COLLECT stage (rarebit-one/rarebit-sre#582).
//
// The skill under test lives in rarebit-one/workspace-config
// (`.agents/skills/land/SKILL.md`), not in this repo: pass it with --skill (the
// workflow checks workspace-config out read-only at a pinned SHA and passes that
// SHA as --skill-ref, which every record keeps). For each scenario × trial it
// builds a sandbox (world.mjs: a bare origin standing in for nutripod-web, its
// open PRs in a stub gh, stub doctl and curl for the staging watch), runs
// `/land <pr>` headless, and records the transcript and every stub call.
// score.mjs grades the records.
//
// Nothing can merge for real: `gh pr merge` lands in the stub, which squashes onto
// the sandbox's bare origin. See ../runner/README.md for the isolation.
//
// Usage:
//   node evals/skills/land/run.mjs --skill <workspace-config>/.agents/skills/land/SKILL.md \
//     [--skill-ref <sha>] --scenarios green-merge,stacked-base --n 1 --out <file>.runs.jsonl
// Flags: as release/run.mjs (--n 3, --model = the skill's frontmatter model,
//        --max-run-usd 3, --max-total-usd 10, --timeout-s 1200, --fresh-config, --keep, --resume)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { git, installStub, makeSandbox, RUNNER_FILES, sh } from "../runner/sandbox.mjs";
import { commonFlags, runTrials, skillModel } from "../runner/driver.mjs";
import { buildSeed, REPO, SCENARIOS, TURNS, worldFor } from "./world.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function setupRun({ skillPath, skillRef = null }) {
  return ({ runRoot }) => {
    const skillText = fs.readFileSync(skillPath, "utf8");
    const { seed, shas } = buildSeed({ runRoot, skillText });
    let blob = null;
    try { blob = sh("git", ["hash-object", skillPath]); } catch { /* git missing */ }
    return { seed, shas, record: { skill_source: "rarebit-one/workspace-config:.agents/skills/land/SKILL.md", skill_ref: skillRef, skill_blob: blob, skill_sha256: crypto.createHash("sha256").update(skillText).digest("hex").slice(0, 16) } };
  };
}

export function setupTrial({ runCtx, runRoot, keys, scenario }) {
  const s = makeSandbox({ runRoot, keys, seed: runCtx.seed, repo: REPO });
  const w = worldFor(scenario, { bare: s.bare });
  // Only the scenario's PR branches (and main) exist on its origin.
  const keep = new Set(["main", ...Object.values(w.world.prs).map((p) => p.head)]);
  for (const line of git(s.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n")) if (line && !keep.has(line)) git(s.bare, "update-ref", "-d", `refs/heads/${line}`);
  fs.writeFileSync(path.join(s.state, "world.json"), JSON.stringify(w.world, null, 2));
  fs.writeFileSync(path.join(s.state, "http.json"), JSON.stringify(w.http, null, 2));
  fs.writeFileSync(path.join(s.state, "canned.json"), JSON.stringify(w.canned, null, 2));
  const files = { ...RUNNER_FILES, "land/gh-stub.mjs": path.join(HERE, "gh-stub.mjs") };
  installStub({ bin: s.bin, state: s.state, name: "gh", entry: "land/gh-stub.mjs", files });
  installStub({ bin: s.bin, state: s.state, name: "curl", entry: "runner/http-stub.mjs", files, extra: ["--name", "curl"] });
  for (const tool of Object.keys(w.canned)) installStub({ bin: s.bin, state: s.state, name: tool, entry: "runner/canned-stub.mjs", files, extra: ["--name", tool] });

  const cwd = path.join(s.sandbox, "nutripod-web");
  sh("git", ["clone", "-q", "--branch", "main", `https://github.com/${REPO}.git`, cwd], { env: s.gitEnv });
  const refsBefore = git(s.bare, "for-each-ref", "--format=%(refname) %(objectname)").split("\n");

  return {
    ...s, cwd, turns: TURNS[scenario],
    collect: () => {
      const st = fs.existsSync(path.join(s.state, "gh-state.json")) ? JSON.parse(fs.readFileSync(path.join(s.state, "gh-state.json"), "utf8")) : { prs: {}, merges: [] };
      return {
        world: w.facts,
        refs_before: refsBefore,
        refs_after: git(s.bare, "for-each-ref", "--format=%(refname) %(objectname)").split("\n"),
        prs_final: Object.fromEntries(Object.entries(w.world.prs).map(([n, p]) => [n, { base: st.prs[n]?.base ?? p.base, state: st.prs[n]?.state ?? "OPEN", head: p.head, closed_reason: st.prs[n]?.closedReason ?? null }])),
        merges: st.merges || [],
      };
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--skill");
  if (i < 0 || !argv[i + 1]) throw new Error("--skill <path to workspace-config/.agents/skills/land/SKILL.md> is required");
  const skillPath = path.resolve(argv[i + 1]);
  const j = argv.indexOf("--skill-ref");
  const f = commonFlags(argv, { name: "land-eval", scenarios: SCENARIOS, timeoutS: 1200, maxRunUsd: 3, maxTotalUsd: 10,
    model: skillModel(fs.readFileSync(skillPath, "utf8")),
    out: path.join(HERE, "results", `${new Date().toISOString().slice(0, 10)}-local.runs.jsonl`) });
  console.error(`model: ${f.model} (${f.model_source})`);
  process.exitCode = await runTrials({
    ...f, name: "land", allScenarios: SCENARIOS,
    setupRun: setupRun({ skillPath, skillRef: j >= 0 ? argv[j + 1] : null }), setupTrial,
    summarize: (rec) => `merges=${rec.gh.filter((c) => c.merge).length} retargets=${rec.gh.filter((c) => c.retarget).length}`,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
