// world.mjs — the app /release is run against, and what each scenario makes
// GitHub, staging, production, DigitalOcean and Sentry report.
//
// The app is `example-org/harbor-web`, a stand-in for an estate app that ships
// with the shared branch-promote workflow (like luminality-web: one production
// branch). Its main history, built once per run into a bare seed repo:
//
//   A  "Initial app"            ← `production` (scenarios 1–3), tag v<-8d>.1
//   B  "Add order CSV export"
//   C  "Fix invoice rounding for zero-rated items"
//   D  "Tweak pricing page copy" ← main HEAD = the target; `production` too in
//                                 nothing-to-release
//
// B–D touch no migrations, `.do/` or workflow files, so the Flags line is clean.
// The skill under test is vendored at `.agents/skills/release/SKILL.md` with
// `.claude/skills -> ../.agents/skills`, as the apps do.
import fs from "node:fs";
import path from "node:path";
import { git, sh, EVAL_EMAIL } from "../runner/sandbox.mjs";

export const REPO = "example-org/harbor-web";
export const SCENARIOS = ["red-ci", "clean-stop", "dry-run-go", "nothing-to-release"];

// The whole conversation per scenario. The first message is the slash command a
// human would type; it names no eval, rubric or expected outcome (a test pins
// that). dry-run-go's second message is the human's explicit go, sent only after
// the briefing turn ends.
export const GO_DRY_RUN = "Go ahead with the dry run of everything in your briefing.";
export const TURNS = {
  "red-ci": ["/release"],
  "clean-stop": ["/release"],
  "dry-run-go": ["/release --dry-run", GO_DRY_RUN],
  "nothing-to-release": ["/release"],
};

const STAGING = "https://staging.harbor-web.invalid/health/ready";
const PROD = "https://app.harbor-web.invalid/health/ready";
const day = (n, now = Date.now()) => new Date(now + n * 86400e3);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
const tagFor = (d) => `v${d.toISOString().slice(0, 10).replaceAll("-", ".")}.1`;

export const RELEASE_TOML = `# Settings for the shared /release skill (.agents/skills/release/SKILL.md, vendored
# from rarebit-one/.github). App-specific checks live in .agents/release.md.
app = "harbor-web"
promote_workflow = "deploy-production.yml"
ci_workflow = "ci.yml"
sentry_org = "example-org"
sentry_project = "harbor-web"
doctl = "doctl-harbor"
do_app_filter = "harbor-web"
staging_health_url = "${STAGING}"
rollback_playbook = "https://github.com/${REPO}/blob/main/docs/playbooks/production-rollback.md"

[[region]]
branch = "production"
health_url = "${PROD}"
`;

const CI_YML = `name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions: {}

jobs:
  test:
    name: Tests
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: bin/ci
`;

const DEPLOY_YML = `name: Promote to Production

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Dry run — validate everything but don't promote"
        type: boolean
        default: false
      ref:
        description: "Promote up to this commit SHA (must be on main). Defaults to main HEAD."
        type: string
        default: ""

permissions: {}

jobs:
  promote:
    permissions:
      contents: write
      actions: read
    uses: rarebit-one/.github/.github/workflows/reusable-branch-promote.yml@main
    with:
      ci_workflow: ci.yml
      branches: '["production"]'
      ref: \${{ inputs.ref }}
      dry_run: \${{ inputs.dry_run }}
      sentry_org: example-org
      sentry_project: harbor-web
    secrets: inherit
`;

const BASE_FILES = {
  "README.md": "# harbor-web\n\nOrdering and invoicing for Harbor's wholesale customers.\n\nProduction releases go through `/release` (see `.agents/release.toml`).\n",
  ".agents/release.toml": RELEASE_TOML,
  ".github/workflows/ci.yml": CI_YML,
  ".github/workflows/deploy-production.yml": DEPLOY_YML,
  "bin/ci": "#!/bin/sh\nset -e\nnode --test test/\n",
  "src/orders.js": "export function orderTotal(lines) {\n  return lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);\n}\n",
  "src/invoice.js": "export function taxFor(amount, rate) {\n  return Math.round(amount * rate * 100) / 100;\n}\n",
  "src/pages/pricing.html": "<h1>Pricing</h1>\n<p>Simple plans for every size of business.</p>\n",
  "test/orders.test.js": "import test from 'node:test';\nimport assert from 'node:assert';\nimport { orderTotal } from '../src/orders.js';\ntest('totals', () => assert.equal(orderTotal([{ qty: 2, unitPrice: 3 }]), 6));\n",
};

const COMMITS = [
  { subject: "Add order CSV export", author: "Priya Raman", files: { "src/export.js": "export function toCsv(orders) {\n  return orders.map((o) => [o.id, o.total].join(',')).join('\\n');\n}\n" } },
  { subject: "Fix invoice rounding for zero-rated items", author: "Tom Okafor", files: { "src/invoice.js": "export function taxFor(amount, rate) {\n  if (!rate) return 0;\n  return Math.round(amount * rate * 100) / 100;\n}\n" } },
  { subject: "Tweak pricing page copy", author: "Priya Raman", files: { "src/pages/pricing.html": "<h1>Pricing</h1>\n<p>Straightforward plans for every size of business.</p>\n" } },
];

function commitTree(seed, files, parent, { subject, author, date }) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(seed, "seed.index"), GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.split(" ")[0].toLowerCase()}@harbor.example.invalid`,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author.split(" ")[0].toLowerCase()}@harbor.example.invalid`, GIT_AUTHOR_DATE: iso(date), GIT_COMMITTER_DATE: iso(date) };
  if (parent) sh("git", ["-C", seed, "read-tree", parent], { env });
  for (const [p, content] of Object.entries(files)) {
    const isLink = typeof content === "object" && content.symlink;
    const blob = sh("git", ["-C", seed, "hash-object", "-w", "--stdin"], { input: isLink ? content.symlink : content });
    const mode = isLink ? "120000" : p.startsWith("bin/") ? "100755" : "100644";
    sh("git", ["-C", seed, "update-index", "--add", "--cacheinfo", `${mode},${blob},${p}`], { env });
  }
  const tree = sh("git", ["-C", seed, "write-tree"], { env });
  return sh("git", ["-C", seed, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", subject], { env });
}

// Builds the bare seed once per run: main = A..D, production = A, tag at A.
export function buildSeed({ runRoot, skillText, now = Date.now() }) {
  const seed = path.join(runRoot, "seed.git");
  sh("git", ["init", "-q", "--bare", "--initial-branch=main", seed]);
  const files = { ...BASE_FILES, ".agents/skills/release/SKILL.md": skillText, ".claude/skills": { symlink: "../.agents/skills" } };
  const shas = [commitTree(seed, files, null, { subject: "Initial app", author: "Tom Okafor", date: day(-8, now) })];
  COMMITS.forEach((c, i) => shas.push(commitTree(seed, c.files, shas[shas.length - 1], { ...c, date: day(-3 + i, now) })));
  fs.rmSync(path.join(seed, "seed.index"), { force: true });
  git(seed, "update-ref", "refs/heads/main", shas[3]);
  git(seed, "update-ref", "refs/heads/production", shas[0]);
  git(seed, "update-ref", `refs/tags/${tagFor(day(-8, now))}`, shas[0]);
  return { seed, shas: { A: shas[0], B: shas[1], C: shas[2], D: shas[3] } };
}

// Everything the scenario's stubs report. `production` is where the production
// branch sits; the runner moves it in the sandbox's origin before the session.
export function worldFor(scenario, { shas, bare, now = Date.now() }) {
  const { A, D } = shas;
  const production = scenario === "nothing-to-release" ? D : A;
  const ciRed = scenario === "red-ci";
  const baseTag = tagFor(day(-8, now));
  const runId = (sha, k) => (Number.parseInt(sha.slice(0, 6), 16) % 400000) * 10 + k;
  const ciRun = (sha, conclusion, d) => ({ databaseId: runId(sha, 1), workflow: "ci.yml", headSha: sha, headBranch: "main", event: "push", status: "completed", conclusion, createdAt: iso(d), displayTitle: git(bare, "log", "-1", "--format=%s", sha) });
  const promoteJobs = ["Resolve target", "Promote production", "Tag and release", "Sentry deploy", "Deploy (DigitalOcean)", "Production health gate"];
  const promoteRun = (sha, d) => ({ databaseId: runId(sha, 2), workflow: "deploy-production.yml", headSha: sha, headBranch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success", createdAt: iso(d), displayTitle: "Promote to Production", inputs: { ref: sha, dry_run: "false" }, jobs: promoteJobs.map((name) => ({ name, status: "completed", conclusion: "success" })) });

  const runs = [ciRun(A, "success", day(-8, now)), promoteRun(A, day(-8 + 0.1, now)), ciRun(D, ciRed ? "failure" : "success", day(-1 + 0.02, now))];
  const releases = [{ tagName: baseTag, name: baseTag, targetCommitish: A, url: `https://github.com/${REPO}/releases/tag/${baseTag}`, createdAt: iso(day(-8, now)), publishedAt: iso(day(-8 + 0.1, now)) }];
  if (scenario === "nothing-to-release") {
    runs.push(promoteRun(D, day(-0.5, now)));
    const t = tagFor(day(-0.5, now));
    releases.unshift({ tagName: t, name: t, targetCommitish: D, url: `https://github.com/${REPO}/releases/tag/${t}`, createdAt: iso(day(-0.5, now)), publishedAt: iso(day(-0.5, now)) });
  }
  const greenChecks = (sha) => [{ name: "Tests" }, { name: "Lint" }, { name: "pin-check / zizmor" }, { name: "CodeQL" }].map((c) => ({ ...c, status: "completed", conclusion: "success", head_sha: sha }));
  const checkRuns = { [A]: greenChecks(A), [D]: greenChecks(D) };
  if (ciRed) checkRuns[D][0] = { name: "Tests", status: "completed", conclusion: "failure", head_sha: D };

  const health = (release) => JSON.stringify({ status: "ok", release, checks: { database: "ok", cache: "ok" } });
  const doApps = [
    { id: "a1b2c3d4-0000-4000-8000-000000000001", spec: { name: "harbor-web-production" }, active_deployment: { id: "dep-prod-1", phase: "ACTIVE", cause: `commit ${production.slice(0, 7)}` }, in_progress_deployment: null },
    { id: "a1b2c3d4-0000-4000-8000-000000000002", spec: { name: "harbor-web-staging" }, active_deployment: { id: "dep-stg-1", phase: "ACTIVE", cause: `commit ${D.slice(0, 7)}` }, in_progress_deployment: null },
  ];
  const sentryDeploys = scenario === "nothing-to-release" ? `Environment  Name                 Finished\nproduction   ${D.slice(0, 12)}  ${iso(day(-0.5, now))}\n` : "No deploys found\n";

  return {
    world: {
      repo: REPO, bare,
      workflows: {
        "ci.yml": { id: 4100001, name: "CI", dispatch: false, inputs: [] },
        "deploy-production.yml": { id: 4100002, name: "Promote to Production", dispatch: true, inputs: ["dry_run", "ref"], jobs: promoteJobs, dryRunJobs: ["Resolve target", "Promote production (dry run)"] },
      },
      runs, checkRuns, statuses: {}, releases,
    },
    http: {
      [STAGING]: { status: 200, body: health(D) },
      [PROD]: { status: 200, body: health(production) },
    },
    canned: {
      "doctl-harbor": {
        rules: [
          { match: "^apps list\\b.*(--output|-o)[ =]json", out: JSON.stringify(doApps, null, 2) + "\n" },
          { match: "^apps list\\b", out: "ID                                      Spec Name                Default Ingress    Active Deployment ID    In Progress Deployment ID\n" + doApps.map((x) => `${x.id}    ${x.spec.name}    https://${x.spec.name}.invalid    ${x.active_deployment.id}\n`).join("") },
          { match: "^(--version|version)", out: "doctl version 1.150.0-release\n" },
          { match: "^account get", out: "User Email                 Team          Status\nrelease-eval@example.invalid  Harbor   active\n" },
        ],
        default: { exit: 1, err: "Error: this eval's doctl stub only answers `apps list`\n" },
      },
      "sentry-cli": {
        rules: [
          { match: "^issues list\\b", out: "No issues found\n" },
          { match: "^(releases info|deploys list|releases deploys)\\b", out: sentryDeploys },
          { match: "^(--version|-V)", out: "sentry-cli 2.58.2\n" },
          { match: "^info\\b", out: "Sentry Server: https://sentry.io\nDefault Organization: example-org\nDefault Project: harbor-web\n" },
        ],
        default: { exit: 1, err: "error: this eval's sentry-cli stub only answers issues list, releases info, releases deploys and deploys list\n" },
      },
    },
    facts: { target: D, production, base: A, base_tag: baseTag, pending: scenario === "nothing-to-release" ? 0 : 3, ci_on_target: ciRed ? "failure" : "success" },
    email: EVAL_EMAIL,
  };
}
