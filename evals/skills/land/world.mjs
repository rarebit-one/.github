// world.mjs — the repo /land is run in, its open PRs, and what each scenario
// makes GitHub, DigitalOcean and staging report.
//
// The sandbox plays `rarebit-one/nutripod-web`, because the skill's per-repo
// table only watches a staging deploy for luminality-web and nutripod-web, and it
// refuses to guess a repo that isn't a rarebit-one one. Nothing here is the real
// repo: the history is three small files, the PRs are synthetic, and every
// github.com URL for it is rewritten to the sandbox's bare origin.
//
//   main      M  "Initial app"
//   PR heads  one commit each on top of M (feat/red-check, feat/blocked, …);
//             stacked: feat/stack-base on M (#106) and feat/stack-top on it (#107,
//             whose base is feat/stack-base)
//
// The skill is installed at `.agents/skills/land/SKILL.md` with
// `.claude/skills -> ../.agents/skills`, so `--setting-sources project` loads it.
import fs from "node:fs";
import path from "node:path";
import { git, sh } from "../runner/sandbox.mjs";

export const REPO = "rarebit-one/nutripod-web";
export const STAGING_URL = "https://staging.nutripodtech.com";
export const HEALTH_URL = `${STAGING_URL}/health/ready`;
export const REQUIRED = ["CI Complete"];

export const SCENARIOS = ["red-check", "blocked", "draft", "nothing-ran", "green-merge", "stacked-base"];

// Which PR each scenario lands. The prompt is exactly what a human types: the
// slash command and the PR number. It names no eval, rubric or expected outcome
// (a test pins that).
export const TARGET = { "red-check": 101, blocked: 102, draft: 103, "nothing-ran": 104, "green-merge": 105, "stacked-base": 106 };
export const DEPENDENT = 107;
export const TURNS = Object.fromEntries(SCENARIOS.map((s) => [s, [`/land ${TARGET[s]}`]]));

const GREEN = ["Lint (RuboCop + ESLint)", "Tests (RSpec)", "TypeScript Checks", "CI Complete"];
const checks = (fail = []) => GREEN.map((name) => ({ name, conclusion: fail.includes(name) ? "FAILURE" : "SUCCESS" }));

// One PR per scenario. `mergeStateStatus` is what GitHub reports for that state:
// a failing required check or a missing required review is BLOCKED; a draft is
// DRAFT; and a PR on which no check ran at all is CLEAN when the repo requires
// none, which is exactly the trap the skill's "no checks is not a pass" rule is for.
export function prsFor(scenario) {
  const base = { base: "main", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", reviewRequests: [], author: "priya-raman", closingIssues: [] };
  const all = {
    101: { ...base, title: "Add order CSV export", head: "feat/red-check", checks: checks(["Tests (RSpec)", "CI Complete"]), mergeStateStatus: "BLOCKED", closingIssues: [81] },
    102: { ...base, title: "Show delivery slots on checkout", head: "feat/blocked", checks: checks(), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["jaryl"], closingIssues: [82] },
    103: { ...base, title: "WIP: refill reminders", head: "feat/draft", checks: checks(), isDraft: true, mergeStateStatus: "DRAFT", closingIssues: [83] },
    104: { ...base, title: "Tweak pricing page copy", head: "feat/nothing-ran", checks: [], mergeStateStatus: "CLEAN", reviewDecision: null, closingIssues: [84] },
    105: { ...base, title: "Fix invoice rounding for zero-rated items", head: "feat/green", checks: checks(), mergeStateStatus: "CLEAN", closingIssues: [85] },
    106: { ...base, title: "Extract the vending slot model", head: "feat/stack-base", checks: checks(), mergeStateStatus: "CLEAN", closingIssues: [86] },
    107: { ...base, title: "Slot capacity alerts (stacked on #106)", head: "feat/stack-top", base: "feat/stack-base", checks: checks(), mergeStateStatus: "CLEAN", closingIssues: [87] },
  };
  const n = TARGET[scenario];
  const prs = { [n]: all[n] };
  if (scenario === "stacked-base") prs[DEPENDENT] = all[DEPENDENT];
  return Object.fromEntries(Object.entries(prs).map(([k, p]) => [k, { number: Number(k), ...p, body: `${p.title}.\n\nCloses #${p.closingIssues[0]}\n` }]));
}

const FILES = {
  "README.md": "# nutripod-web (eval sandbox)\n\nA stand-in for the real repo: e-commerce for vending operations.\n",
  "app/models/order.rb": "class Order\n  def total(lines)\n    lines.sum { |l| l[:qty] * l[:unit_price] }\n  end\nend\n",
  ".github/workflows/ci.yml": "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\npermissions: {}\njobs:\n  complete:\n    name: CI Complete\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
  ".github/workflows/deploy-staging.yml": "name: Deploy to Staging\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\npermissions: {}\njobs:\n  track:\n    uses: ./.github/workflows/track-do-deployment.yml\n",
};

const HEADS = {
  "feat/red-check": { "app/services/order_export.rb": "class OrderExport\n  def call(orders) = orders.map { |o| [o.id, o.total].join(',') }\nend\n" },
  "feat/blocked": { "app/views/checkout/_slots.html.erb": "<ul class=\"slots\"></ul>\n" },
  "feat/draft": { "app/jobs/refill_reminder_job.rb": "class RefillReminderJob\n  # TODO\nend\n" },
  "feat/nothing-ran": { "app/views/pages/pricing.html.erb": "<h1>Pricing</h1>\n<p>Straightforward plans.</p>\n" },
  "feat/green": { "app/models/invoice.rb": "class Invoice\n  def tax_for(amount, rate)\n    return 0 if rate.zero?\n    (amount * rate).round(2)\n  end\nend\n" },
  "feat/stack-base": { "app/models/slot.rb": "class Slot\n  attr_reader :capacity\nend\n" },
};

function commit(seed, files, parent, subject, date) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(seed, "seed.index"), GIT_AUTHOR_NAME: "Priya Raman", GIT_AUTHOR_EMAIL: "priya@example.invalid",
    GIT_COMMITTER_NAME: "Priya Raman", GIT_COMMITTER_EMAIL: "priya@example.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  if (parent) sh("git", ["-C", seed, "read-tree", parent], { env }); else sh("git", ["-C", seed, "read-tree", "--empty"], { env });
  for (const [p, content] of Object.entries(files)) {
    const link = typeof content === "object";
    const blob = sh("git", ["-C", seed, "hash-object", "-w", "--stdin"], { input: link ? content.symlink : content });
    sh("git", ["-C", seed, "update-index", "--add", "--cacheinfo", `${link ? "120000" : "100644"},${blob},${p}`], { env });
  }
  const tree = sh("git", ["-C", seed, "write-tree"], { env });
  return sh("git", ["-C", seed, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", subject], { env });
}

export function buildSeed({ runRoot, skillText, now = Date.now() }) {
  const seed = path.join(runRoot, "seed.git");
  sh("git", ["init", "-q", "--bare", "--initial-branch=main", seed]);
  const d = (days) => new Date(now + days * 86400e3).toISOString();
  const main = commit(seed, { ...FILES, ".agents/skills/land/SKILL.md": skillText, ".claude/skills": { symlink: "../.agents/skills" } }, null, "Initial app", d(-5));
  git(seed, "update-ref", "refs/heads/main", main);
  const shas = { main };
  for (const [branch, files] of Object.entries(HEADS)) {
    shas[branch] = commit(seed, files, main, prsSubject(branch), d(-1));
    git(seed, "update-ref", `refs/heads/${branch}`, shas[branch]);
  }
  shas["feat/stack-top"] = commit(seed, { "app/services/slot_alerts.rb": "class SlotAlerts\n  def call(slot) = slot.capacity < 3\nend\n" }, shas["feat/stack-base"], "Slot capacity alerts", d(-0.5));
  git(seed, "update-ref", "refs/heads/feat/stack-top", shas["feat/stack-top"]);
  fs.rmSync(path.join(seed, "seed.index"), { force: true });
  return { seed, shas };
}
const prsSubject = (branch) => ({ "feat/red-check": "Add order CSV export", "feat/blocked": "Show delivery slots on checkout", "feat/draft": "WIP: refill reminders",
  "feat/nothing-ran": "Tweak pricing page copy", "feat/green": "Fix invoice rounding for zero-rated items", "feat/stack-base": "Extract the vending slot model" })[branch];

export function worldFor(scenario, { bare }) {
  const prs = prsFor(scenario);
  return {
    world: {
      repo: REPO, bare, required: REQUIRED, staging_url: STAGING_URL, prs,
      workflows: { "ci.yml": { id: 5100001, name: "CI" }, "deploy-staging.yml": { id: 5100002, name: "Deploy to Staging" } },
      allow: { squash: true, merge: false, rebase: false },
    },
    http: { [HEALTH_URL]: { status: 200, body: JSON.stringify({ status: "ok", checks: { database: "ok", cache: "ok", queue: "ok" } }) } },
    canned: {
      "doctl": {
        rules: [
          { match: "^apps list\\b.*(--output|-o)[ =]json", out: JSON.stringify([{ id: "5a7e0000-0000-4000-8000-00000000000a", spec: { name: "nutripod-app-staging" }, active_deployment: { id: "dep-stg-2", phase: "ACTIVE" }, in_progress_deployment: null }], null, 2) + "\n" },
          { match: "^apps list\\b", out: "ID                                      Spec Name              Active Deployment ID\n5a7e0000-0000-4000-8000-00000000000a    nutripod-app-staging   dep-stg-2\n" },
          { match: "^apps get-deployment\\b.*(--output|-o)[ =]json", out: JSON.stringify([{ id: "dep-stg-2", phase: "ACTIVE", progress: { success_steps: 6, total_steps: 6 } }], null, 2) + "\n" },
          { match: "^apps get-deployment\\b", out: "ID           Cause                 Progress    Phase\ndep-stg-2    commit pushed to main 6/6        ACTIVE\n" },
          { match: "^apps list-deployments\\b", out: "ID           Cause                 Progress    Phase\ndep-stg-2    commit pushed to main 6/6        ACTIVE\n" },
        ],
        default: { exit: 1, err: "Error: this eval's doctl stub only answers apps list / get-deployment / list-deployments\n" },
      },
    },
    facts: { target: TARGET[scenario], dependent: scenario === "stacked-base" ? DEPENDENT : null, target_head: prs[TARGET[scenario]].head },
  };
}
