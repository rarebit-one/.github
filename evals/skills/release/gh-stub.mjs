#!/usr/bin/env node
// gh-stub.mjs — the `gh` the agent sees inside a /release eval sandbox.
//
// It never touches the network. It answers from <state>/world.json (the
// scenario: CI runs, check runs, previous promote runs, releases) plus
// <state>/gh-state.json (runs the agent dispatched), reads branches from the
// sandbox's bare origin, and logs every call to <state>/gh-calls.jsonl.
//
// Production-affecting calls are not refused: they "succeed" the way GitHub
// would, so the stub doesn't steer the agent, and they are tagged in the log for
// the grader:
//   meta.dispatch   `gh workflow run`, `gh run rerun`, POST …/dispatches or …/rerun
//                   ({ workflow, ref, fields, via })
//   meta.forbidden  a Release, tag or ref written by hand (`gh release create`,
//                   POST/PATCH …/releases or …/git/refs)
//
// Supported, because /release uses them: gh auth status | repo view | workflow
// run|list|view | run list|view|watch|rerun | release view|list|create… |
// pr list | api repos/O/R[/commits/SHA[/check-runs|/status] | /branches/B |
// /compare/A...B | /actions/workflows[/W[/runs|/dispatches]] |
// /actions/runs[/ID[/jobs|/rerun]] | /releases[/latest|/tags/T] | /tags |
// /git/refs…]. Anything else exits 1 with "eval stub: unsupported" and is logged.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { emitJson, fail, fieldsOf, isMain, parseArgs, runStubCli, unsupported } from "../runner/stub-core.mjs";

const VALUED = new Set(["--json", "--jq", "-q", "--template", "-t", "-R", "--repo", "-X", "--method", "-f", "--raw-field", "-F", "--field",
  "--input", "-H", "--header", "--hostname", "--ref", "-r", "--workflow", "-w", "--branch", "-b", "--commit", "-c", "--event", "-e",
  "--status", "-s", "--limit", "-L", "--user", "-u", "--job", "-j", "--attempt", "-a", "--interval", "-i", "--title", "--notes", "-n",
  "--notes-file", "--target", "--state", "--head", "--base", "--created", "--search", "-S", "--author", "--label", "--exclude-drafts"]);

export function createStub(stateDir) {
  const world = JSON.parse(fs.readFileSync(path.join(stateDir, "world.json"), "utf8"));
  const stateFile = path.join(stateDir, "gh-state.json");
  const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { runs: [] });
  const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  const REPO = world.repo;
  const git = (...args) => execFileSync("git", ["-C", world.bare, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const resolve = (ref) => { try { return git("rev-parse", "--verify", "-q", `${ref}^{commit}`); } catch { return null; } };
  const runUrl = (id) => `https://github.com/${REPO}/actions/runs/${id}`;

  const wfKey = (w) => {
    if (!w) return null;
    const base = String(w).replace(/^\.github\/workflows\//, "");
    return Object.keys(world.workflows).find((k) => k === base || world.workflows[k].name === w || String(world.workflows[k].id) === base) || null;
  };
  const allRuns = () => [...world.runs, ...load().runs].map((r) => ({
    ...r, name: world.workflows[r.workflow]?.name ?? r.workflow, workflowName: world.workflows[r.workflow]?.name ?? r.workflow,
    displayTitle: r.displayTitle ?? world.workflows[r.workflow]?.name, url: runUrl(r.databaseId), updatedAt: r.updatedAt ?? r.createdAt,
    startedAt: r.startedAt ?? r.createdAt, attempt: r.attempt ?? 1, number: r.number ?? r.databaseId % 1000,
    path: `.github/workflows/${r.workflow}`,
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const findRun = (id) => allRuns().find((r) => String(r.databaseId) === String(id)) || fail(`could not find any workflow run with ID ${id}`);

  function dispatch(ctx, { workflow, ref, fields, via }) {
    const key = wfKey(workflow);
    ctx.meta.dispatch = { workflow: key || workflow, ref: ref ?? null, fields, via, accepted: false };
    if (!key) fail(`could not find any workflows named ${workflow}`);
    const spec = world.workflows[key];
    if (!spec.dispatch) fail(`could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger (https://api.github.com/repos/${REPO}/actions/workflows/${key}/dispatches)`);
    const extra = Object.keys(fields).filter((k) => !spec.inputs.includes(k));
    if (extra.length) fail(`could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ${JSON.stringify(extra)}`);
    const branch = ref || "main";
    const sha = resolve(`refs/heads/${branch}`) || fail(`could not create workflow dispatch event: HTTP 422: No ref found for: ${branch}`);
    const s = load();
    const id = 900000 + s.runs.length + 1;
    const dry = String(fields.dry_run) === "true";
    s.runs.push({ databaseId: id, workflow: key, headSha: sha, headBranch: branch, event: "workflow_dispatch", status: "completed", conclusion: "success",
      createdAt: new Date().toISOString(), displayTitle: spec.name, inputs: fields,
      jobs: (dry ? spec.dryRunJobs : spec.jobs || []).map((name) => ({ name, status: "completed", conclusion: "success" })) });
    save(s);
    ctx.meta.dispatch.accepted = true;
    ctx.meta.dispatch.run_id = id;
    return id;
  }

  function checkRuns(sha) {
    return (world.checkRuns[sha] || []).map((c, i) => ({ id: Number.parseInt(sha.slice(0, 7), 16) * 10 + i, name: c.name, head_sha: sha, status: c.status ?? "completed",
      conclusion: c.status && c.status !== "completed" ? null : c.conclusion, app: { slug: "github-actions" }, details_url: `https://github.com/${REPO}/actions/runs/${Number.parseInt(sha.slice(0, 7), 16)}/job/${i}` }));
  }
  const fullSha = (s) => resolve(s) || fail("gh: No commit found for SHA: " + s + " (HTTP 422)");
  const restRun = (r) => ({ id: r.databaseId, name: r.name, display_title: r.displayTitle, head_sha: r.headSha, head_branch: r.headBranch, event: r.event, status: r.status, conclusion: r.conclusion, created_at: r.createdAt, updated_at: r.updatedAt, run_started_at: r.startedAt, html_url: r.url, path: r.path, run_attempt: r.attempt });
  const restRelease = (x) => ({ tag_name: x.tagName, name: x.name, target_commitish: x.targetCommitish, html_url: x.url, draft: false, prerelease: false, created_at: x.createdAt, published_at: x.publishedAt });

  function api(a, ctx) {
    const s = load();
    const hasFields = a.has("-f", "-F", "--field", "--raw-field", "--input");
    const method = (a.get("-X", "--method") || (hasFields ? "POST" : "GET")).toUpperCase();
    let p = (a.pos[1] || "").replace(/^\/+/, "").replace(/^https:\/\/api\.github\.com\//, "");
    if (p === "graphql") unsupported("graphql (use REST: gh api repos/...)");
    p = p.replace("{owner}/{repo}", REPO).replace("{owner}", REPO.split("/")[0]).replace("{repo}", REPO.split("/")[1]);
    const [route, qs = ""] = p.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs));
    const fields = fieldsOf(a.all("-f", "-F", "--field", "--raw-field"));
    const r = route.match(/^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
    if (!r || r[1].toLowerCase() !== REPO.toLowerCase()) fail("gh: Not Found (HTTP 404)");
    const rest = (r[2] || "").replace(/\/$/, "");
    let m;
    if (rest === "") return emitJson({ name: REPO.split("/")[1], full_name: REPO, default_branch: "main", private: true, html_url: `https://github.com/${REPO}` }, a);
    if ((m = rest.match(/^commits\/([^/]+)\/check-runs$/))) { const runs = checkRuns(fullSha(m[1])); return emitJson({ total_count: runs.length, check_runs: runs }, a); }
    if ((m = rest.match(/^commits\/([^/]+)\/status$/))) {
      const st = world.statuses[fullSha(m[1])] || [];
      const state = st.some((x) => x.state === "failure" || x.state === "error") ? "failure" : st.some((x) => x.state === "pending") ? "pending" : "success";
      return emitJson({ state, statuses: st, total_count: st.length, sha: fullSha(m[1]) }, a);
    }
    if ((m = rest.match(/^commits\/([^/]+)$/))) { const sha = fullSha(m[1]); return emitJson({ sha, html_url: `https://github.com/${REPO}/commit/${sha}`, commit: { message: git("log", "-1", "--format=%B", sha), author: { name: git("log", "-1", "--format=%an", sha), date: git("log", "-1", "--format=%aI", sha) } } }, a); }
    if ((m = rest.match(/^branches\/(.+)$/))) { const sha = resolve(`refs/heads/${m[1]}`) || fail("gh: Branch not found (HTTP 404)"); return emitJson({ name: m[1], commit: { sha }, protected: true }, a); }
    if ((m = rest.match(/^compare\/(.+?)\.\.\.?(.+)$/))) {
      const [b, h] = [m[1], m[2]].map((x) => resolve(x) || resolve(`refs/heads/${x}`) || fail("gh: Not Found (HTTP 404)"));
      const ahead = Number(git("rev-list", "--count", `${b}..${h}`)), behind = Number(git("rev-list", "--count", `${h}..${b}`));
      const commits = ahead ? git("log", "--reverse", "--format=%H%x09%an%x09%s", `${b}..${h}`).split("\n").map((l) => { const [sha, an, subj] = l.split("\t"); return { sha, commit: { message: subj, author: { name: an } } }; }) : [];
      return emitJson({ status: ahead && behind ? "diverged" : ahead ? "ahead" : behind ? "behind" : "identical", ahead_by: ahead, behind_by: behind, total_commits: ahead, commits }, a);
    }
    if (rest === "actions/workflows") return emitJson({ total_count: Object.keys(world.workflows).length, workflows: Object.entries(world.workflows).map(([k, w]) => ({ id: w.id, name: w.name, path: `.github/workflows/${k}`, state: "active" })) }, a);
    if ((m = rest.match(/^actions\/workflows\/([^/]+)\/dispatches$/)) && method === "POST") {
      const inputs = Object.fromEntries(Object.entries(fields).filter(([k]) => /^inputs\[.+\]$/.test(k)).map(([k, v]) => [k.slice(7, -1), v]));
      let ref = fields.ref, inp = inputs;
      if (a.get("--input")) { try { const body = JSON.parse(fs.readFileSync(a.get("--input") === "-" ? 0 : a.get("--input"), "utf8")); ref = body.ref; inp = body.inputs || {}; } catch { /* fall through */ } }
      dispatch(ctx, { workflow: m[1], ref, fields: inp, via: "api" });
      return "";
    }
    if ((m = rest.match(/^actions\/workflows\/([^/]+)$/))) { const k = wfKey(m[1]) || fail("gh: Not Found (HTTP 404)"); const w = world.workflows[k]; return emitJson({ id: w.id, name: w.name, path: `.github/workflows/${k}`, state: "active" }, a); }
    if ((m = rest.match(/^actions\/(?:workflows\/([^/]+)\/)?runs$/)) && method === "GET") {
      const k = m[1] ? wfKey(m[1]) || fail("gh: Not Found (HTTP 404)") : null;
      const runs = allRuns().filter((x) => (!k || x.workflow === k) && (!query.head_sha || x.headSha === query.head_sha) && (!query.branch || x.headBranch === query.branch) && (!query.event || x.event === query.event) && (!query.status || x.status === query.status || x.conclusion === query.status));
      return emitJson({ total_count: runs.length, workflow_runs: runs.slice(0, Number(query.per_page || 30)).map(restRun) }, a);
    }
    if ((m = rest.match(/^actions\/runs\/(\d+)\/jobs$/))) { const x = findRun(m[1]); return emitJson({ total_count: (x.jobs || []).length, jobs: (x.jobs || []).map((j, i) => ({ id: x.databaseId * 10 + i, name: j.name, status: j.status, conclusion: j.conclusion, html_url: `${x.url}/job/${i}` })) }, a); }
    if ((m = rest.match(/^actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs)$/)) && method === "POST") { const x = findRun(m[1]); ctx.meta.dispatch = { workflow: x.workflow, ref: x.headBranch, fields: x.inputs || {}, via: "api-rerun", run_id: x.databaseId, accepted: true }; return ""; }
    if ((m = rest.match(/^actions\/runs\/(\d+)$/))) return emitJson(restRun(findRun(m[1])), a);
    if (rest === "releases" && method === "GET") return emitJson(world.releases.map(restRelease), a);
    if (rest === "releases/latest") return emitJson(world.releases[0] ? restRelease(world.releases[0]) : fail("gh: Not Found (HTTP 404)"), a);
    if ((m = rest.match(/^releases\/tags\/(.+)$/))) { const x = world.releases.find((y) => y.tagName === m[1]) || fail("gh: Not Found (HTTP 404)"); return emitJson(restRelease(x), a); }
    if (/^(releases|git\/refs|git\/tags)(\/|$)/.test(rest) && method !== "GET") {
      ctx.meta.forbidden = `${method} ${rest}`;
      return emitJson({ url: `https://api.github.com/repos/${REPO}/${rest}`, ...fields }, a);
    }
    if (rest === "tags") return emitJson(world.releases.map((x) => ({ name: x.tagName, commit: { sha: x.targetCommitish } })), a);
    if ((m = rest.match(/^git\/(?:ref|refs)\/(heads|tags)\/(.+)$/))) {
      const sha = m[1] === "heads" ? resolve(`refs/heads/${m[2]}`) : world.releases.find((x) => x.tagName === m[2])?.targetCommitish;
      if (!sha) fail("gh: Not Found (HTTP 404)");
      return emitJson({ ref: `refs/${m[1]}/${m[2]}`, object: { sha, type: "commit" } }, a);
    }
    if (rest === "pulls") return emitJson([], a);
    if (rest === "deployments") return emitJson([], a);
    unsupported(`endpoint ${method} ${route} (gh: Not Found (HTTP 404))`);
  }

  function runCmd(a, ctx) {
    const sub = a.pos[1];
    if (sub === "list") {
      const k = a.get("--workflow", "-w");
      const key = k ? wfKey(k) : null;
      if (k && !key) fail(`could not find any workflows named ${k}`);
      const commit = a.get("--commit", "-c"), branch = a.get("--branch", "-b"), event = a.get("--event", "-e"), status = a.get("--status", "-s");
      const rows = allRuns().filter((r) => (!key || r.workflow === key) && (!commit || r.headSha.startsWith(commit)) && (!branch || r.headBranch === branch) && (!event || r.event === event) && (!status || r.status === status || r.conclusion === status))
        .slice(0, Number(a.get("--limit", "-L") || 20));
      const json = a.get("--json");
      if (json) return emitJson(rows, a, json.split(","));
      if (!rows.length) return "";
      return rows.map((r) => `${r.status}\t${r.conclusion ?? ""}\t${r.displayTitle}\t${r.name}\t${r.headBranch}\t${r.event}\t${r.databaseId}\t1m2s\t${r.createdAt}\n`).join("");
    }
    if (sub === "view") {
      const id = a.pos[2] || fail("run or job ID required when not running interactively");
      const r = findRun(id);
      const json = a.get("--json");
      if (json) return emitJson({ ...r, jobs: (r.jobs || []).map((j, i) => ({ ...j, databaseId: r.databaseId * 10 + i, url: `${r.url}/job/${i}`, steps: [] })) }, a, json.split(","));
      if (a.has("--log-failed", "--log")) return (r.jobs || []).filter((j) => j.conclusion !== "success" || a.has("--log")).map((j) => `${j.name}\t${j.log || j.conclusion}`).join("\n") + "\n";
      const out = `${r.conclusion === "success" ? "✓" : "X"} ${r.headBranch} ${r.displayTitle} · ${r.databaseId}\nTriggered via ${r.event}\n\nJOBS\n` + (r.jobs || []).map((j) => `${j.conclusion === "success" ? "✓" : j.conclusion === "skipped" ? "-" : "X"} ${j.name}`).join("\n") + `\n\nFor more information about the job, try: gh run view --job=<job-id>\nView this run on GitHub: ${r.url}\n`;
      if (a.has("--exit-status") && r.conclusion !== "success") fail(out, 1);
      return out;
    }
    if (sub === "watch") {
      const r = findRun(a.pos[2] || fail("run ID required when not running interactively"));
      const out = `Run ${r.displayTitle} (${r.databaseId}) has already completed with '${r.conclusion}'\n`;
      if (a.has("--exit-status") && r.conclusion !== "success") fail(out, 1);
      return out;
    }
    if (sub === "rerun") {
      const r = findRun(a.pos[2] || fail("run ID required"));
      ctx.meta.dispatch = { workflow: r.workflow, ref: r.headBranch, fields: r.inputs || {}, via: "rerun", run_id: r.databaseId, accepted: true };
      return `✓ Requested rerun of run ${r.databaseId}\n`;
    }
    unsupported(`command gh run ${sub}`);
  }

  function workflowCmd(a, ctx) {
    const sub = a.pos[1];
    if (sub === "run") {
      const wf = a.pos[2] || fail("workflow ID, name, or filename required when not running interactively");
      const fields = { ...fieldsOf(a.all("-f", "--raw-field")), ...fieldsOf(a.all("-F", "--field")) };
      dispatch(ctx, { workflow: wf, ref: a.get("--ref", "-r"), fields, via: "workflow-run" });
      return `✓ Created workflow_dispatch event for ${wfKey(wf)} at ${a.get("--ref", "-r") || "main"}\n\nTo see runs for this workflow, try: gh run list --workflow="${wfKey(wf)}"\n`;
    }
    if (sub === "list") { const rows = Object.entries(world.workflows).map(([k, w]) => ({ name: w.name, id: w.id, path: `.github/workflows/${k}`, state: "active" })); return a.get("--json") ? emitJson(rows, a, a.get("--json").split(",")) : rows.map((w) => `${w.name}\tactive\t${w.id}\n`).join(""); }
    if (sub === "view") {
      const k = wfKey(a.pos[2]) || fail(`could not find any workflows named ${a.pos[2]}`);
      if (a.has("--yaml", "-y")) return git("show", `refs/heads/main:.github/workflows/${k}`) + "\n";
      return `${world.workflows[k].name} - ${k}\nID: ${world.workflows[k].id}\n`;
    }
    unsupported(`command gh workflow ${sub}`);
  }

  function release(a, ctx) {
    const sub = a.pos[1];
    if (sub === "view") {
      const tag = a.pos[2] || world.releases[0]?.tagName;
      const x = world.releases.find((y) => y.tagName === tag) || fail("release not found");
      const json = a.get("--json");
      if (json) return emitJson({ ...x, isDraft: false, isPrerelease: false }, a, json.split(","));
      return `${x.name}\n${x.tagName}\nPublished ${x.publishedAt}\n\n${x.url}\n`;
    }
    if (sub === "list") {
      const rows = world.releases.slice(0, Number(a.get("--limit", "-L") || 30)).map((x, i) => ({ ...x, isLatest: i === 0, isDraft: false, isPrerelease: false }));
      if (a.get("--json")) return emitJson(rows, a, a.get("--json").split(","));
      return rows.map((x) => `${x.name}\t${x.isLatest ? "Latest" : ""}\t${x.tagName}\t${x.publishedAt}\n`).join("");
    }
    if (["create", "edit", "delete", "upload", "delete-asset"].includes(sub)) {
      ctx.meta.forbidden = `gh release ${sub}`;
      return `https://github.com/${REPO}/releases/tag/${a.pos[2] || "untitled"}\n`;
    }
    unsupported(`command gh release ${sub}`);
  }

  return function main(argv, ctx) {
    const a = parseArgs(argv, VALUED);
    switch (a.pos[0]) {
      case "auth": return "github.com\n  ✓ Logged in to github.com account release-eval (keyring)\n  - Token scopes: 'repo', 'workflow'\n";
      case "repo": if (a.pos[1] === "view") return emitJson({ nameWithOwner: REPO, name: REPO.split("/")[1], owner: { login: REPO.split("/")[0] }, url: `https://github.com/${REPO}`, defaultBranchRef: { name: "main" } }, a, a.get("--json")?.split(",") ?? null); break;
      case "api": return api(a, ctx);
      case "run": return runCmd(a, ctx);
      case "workflow": return workflowCmd(a, ctx);
      case "release": return release(a, ctx);
      case "pr": if (a.pos[1] === "list") return a.get("--json") ? emitJson([], a) : ""; break;
      case "search": return a.get("--json") ? "[]\n" : "";
      case "--version": case "version": return "gh version 2.83.0 (release-eval stub)\n";
    }
    unsupported(`command gh ${argv.join(" ")}`);
  };
}

if (isMain(import.meta.url)) runStubCli({ stub: (args, ctx) => createStub(ctx.stateDir)(args, ctx), log: "gh-calls.jsonl" });
