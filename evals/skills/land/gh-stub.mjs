#!/usr/bin/env node
// gh-stub.mjs — the `gh` the agent sees inside a /land eval sandbox.
//
// It never touches the network. The scenario's PRs come from <state>/world.json;
// what the agent changes (merges, retargets, deleted branches, closed PRs,
// deployment polls) lives in <state>/gh-state.json; branches and merge commits
// are real refs in the sandbox's bare origin. Every call is logged to
// <state>/gh-calls.jsonl.
//
// Merging behaves as GitHub does, so the stub doesn't steer the agent: a draft
// can't merge; a BLOCKED or DIRTY PR merges only with `--admin`; a CLEAN PR merges
// even when no check ran (GitHub doesn't know your policy; the skill must); only
// squash is allowed in this repo. Deleting a branch that other open PRs target
// CLOSES those PRs (what the estate saw: memory "stacked PR delete-branch trap").
// After a merge, CI on main, the staging deploy run and the GitHub Deployment
// for the merge commit go green; the Deployment's first status read is
// `in_progress`, later ones `success`.
//
// Tagged in the log for the grader:
//   meta.merge      every merge attempt: { pr, method, admin, auto, delete_branch,
//                   via, accepted, closed_dependents }
//   meta.retarget   { pr, from, to }       meta.branch_delete  { branch, closed_dependents }
//   meta.deploy_state  the Deployment status this call reported
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Exit, emitJson, fail, fieldsOf, isMain, parseArgs, runStubCli, unsupported } from "../runner/stub-core.mjs";

const VALUED = new Set(["--json", "--jq", "-q", "--template", "-t", "-R", "--repo", "-X", "--method", "-f", "--raw-field", "-F", "--field", "--input",
  "-H", "--header", "--hostname", "--base", "-B", "--head", "-H", "--state", "-s", "--limit", "-L", "--author", "-A", "--label", "-l", "--search", "-S",
  "--subject", "--body", "-b", "--body-file", "--match-head-commit", "--workflow", "-w", "--branch", "--commit", "-c", "--event", "-e", "--status",
  "--title", "--add-label", "--remove-label", "--add-reviewer", "--reason", "-r", "--comment", "--interval", "-i", "--job", "--attempt", "--author-email"]);
// `gh pr merge`'s own short flags: -s/-r/-m/-d are booleans there.
const MERGE_VALUED = new Set(["--subject", "-t", "--body", "-b", "--body-file", "-F", "--match-head-commit", "--author-email", "-A", "-R", "--repo"]);
const SETTLED_S = 600;

export function createStub(stateDir) {
  const world = JSON.parse(fs.readFileSync(path.join(stateDir, "world.json"), "utf8"));
  const stateFile = path.join(stateDir, "gh-state.json");
  const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { prs: {}, merges: [], deployReads: 0, closedIssues: [] });
  const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  const REPO = world.repo;
  const git = (...args) => execFileSync("git", ["-C", world.bare, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const ref = (b) => { try { return git("rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`); } catch { return null; } };
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const settled = () => iso(Date.now() - SETTLED_S * 1000);
  const url = (n) => `https://github.com/${REPO}/pull/${n}`;

  // A PR as it stands now: the world's fixed facts plus what the agent changed.
  function pr(s, n) {
    const w = world.prs[n];
    if (!w) return null;
    const d = s.prs[n] || {};
    const p = { ...w, ...d };
    p.state = d.state || "OPEN";
    p.headRefOid = d.headRefOid || ref(p.head);
    p.mergeStateStatus = p.state !== "OPEN" ? "UNKNOWN" : p.mergeStateStatus;
    return p;
  }
  const openPrs = (s) => Object.keys(world.prs).map((n) => pr(s, n)).filter((p) => p.state === "OPEN");
  const requirePr = (s, sel) => {
    const n = String(sel ?? "").replace(/^#/, "").replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//, "");
    const p = /^\d+$/.test(n) ? pr(s, n) : Object.keys(world.prs).map((k) => pr(s, k)).find((x) => x.head === sel);
    return p || fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
  };

  function rollup(p) {
    return (p.checks || []).map((c) => ({ __typename: "CheckRun", name: c.name, status: c.status || "COMPLETED", conclusion: c.status && c.status !== "COMPLETED" ? "" : c.conclusion,
      workflowName: "CI", detailsUrl: `https://github.com/${REPO}/actions/runs/${p.number}000/job/1`, startedAt: settled(), completedAt: settled() }));
  }
  function gqlPr(s, p) {
    return {
      number: p.number, title: p.title, body: p.body, url: url(p.number), state: p.state, isDraft: !!p.isDraft, closed: p.state !== "OPEN",
      headRefName: p.head, baseRefName: p.base, headRefOid: p.headRefOid, mergeable: p.state === "OPEN" ? p.mergeable : "UNKNOWN",
      mergeStateStatus: p.mergeStateStatus, reviewDecision: p.reviewDecision ?? "", statusCheckRollup: rollup(p),
      reviewRequests: (p.reviewRequests || []).map((login) => ({ __typename: "User", login })), latestReviews: p.reviewDecision === "APPROVED" ? [{ author: { login: "jaryl" }, state: "APPROVED" }] : [],
      reviews: [], author: { login: p.author, is_bot: false }, labels: [], assignees: [], comments: [],
      mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null, mergedAt: p.mergedAt || null, mergedBy: p.mergedAt ? { login: "skill-eval" } : null,
      closingIssuesReferences: (p.closingIssues || []).map((num) => ({ number: num, url: `https://github.com/${REPO}/issues/${num}`, repository: { name: REPO.split("/")[1], owner: { login: REPO.split("/")[0] } } })),
      autoMergeRequest: d(s, p.number).autoMerge ? { mergeMethod: "SQUASH" } : null, isCrossRepository: false, id: `PR_eval${p.number}`,
      createdAt: settled(), updatedAt: settled(), additions: 5, deletions: 0, changedFiles: 1, commits: [{ oid: p.headRefOid }], files: [],
    };
  }
  const d = (s, n) => (s.prs[n] ??= {});
  function restPr(s, p) {
    return { number: p.number, title: p.title, body: p.body, html_url: url(p.number), state: p.state === "OPEN" ? "open" : "closed", merged: p.state === "MERGED", draft: !!p.isDraft,
      mergeable: p.state === "OPEN" ? p.mergeable === "MERGEABLE" : null, mergeable_state: String(p.mergeStateStatus).toLowerCase(), head: { ref: p.head, sha: p.headRefOid },
      base: { ref: p.base }, user: { login: p.author }, merged_at: p.mergedAt || null, merge_commit_sha: p.mergeCommit || null, requested_reviewers: (p.reviewRequests || []).map((login) => ({ login })) };
  }

  // Deleting a branch: GitHub closes the open PRs that target it.
  function deleteBranch(s, branch, ctx, key) {
    if (!ref(branch)) return [];
    git("update-ref", "-d", `refs/heads/${branch}`);
    const closed = openPrs(s).filter((p) => p.base === branch).map((p) => p.number);
    for (const n of closed) Object.assign(d(s, n), { state: "CLOSED", closedReason: `base branch ${branch} was deleted` });
    ctx.meta[key] = { ...(ctx.meta[key] || {}), branch, closed_dependents: closed };
    return closed;
  }

  function merge(s, ctx, { sel, method, admin = false, auto = false, deleteBranch: del = false, matchHead, via }) {
    const p = requirePr(s, sel);
    ctx.meta.merge = { pr: p.number, method: method || null, admin, auto, delete_branch: del, via, accepted: false };
    if (p.state === "MERGED") fail(`Pull request ${REPO}#${p.number} was already merged`);
    if (p.state === "CLOSED") fail(`Pull request ${REPO}#${p.number} is closed`);
    if (!method) fail("--merge, --rebase, or --squash required when not running interactively");
    if (!world.allow[method]) fail(`GraphQL: ${method === "merge" ? "Merge commits are" : "Rebase merging is"} not allowed on this repository (mergePullRequest)`);
    if (matchHead && matchHead !== p.headRefOid) fail("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)");
    if (auto && !admin && p.mergeStateStatus !== "CLEAN") {
      d(s, p.number).autoMerge = true; save(s);
      ctx.meta.merge.accepted = "auto-armed";
      return `✓ Pull request ${REPO}#${p.number} will be automatically merged via squash when all requirements are met\n`;
    }
    if (p.isDraft) fail(`GraphQL: Pull Request is still a draft (mergePullRequest)`);
    if (p.mergeStateStatus === "DIRTY") fail(`Pull request ${REPO}#${p.number} is not mergeable: the merge commit cannot be cleanly created.`);
    if (p.mergeStateStatus === "BLOCKED" && !admin) fail(`X Pull request ${REPO}#${p.number} is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the \`--auto\` flag.\nTo use administrator privileges to immediately merge the pull request, add the \`--admin\` flag.`);
    const base = ref(p.base) || fail(`base branch ${p.base} not found`);
    const tree = git("rev-parse", `${p.headRefOid}^{tree}`);
    const sha = execFileSync("git", ["-C", world.bare, "commit-tree", tree, "-p", base, "-m", `${p.title} (#${p.number})`], { encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: p.author, GIT_AUTHOR_EMAIL: `${p.author}@example.invalid`, GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" } }).trim();
    git("update-ref", `refs/heads/${p.base}`, sha, base);
    Object.assign(d(s, p.number), { state: "MERGED", mergeCommit: sha, mergedAt: new Date().toISOString(), headRefOid: p.headRefOid });
    s.merges.push({ pr: p.number, sha, base: p.base, at: Date.now() });
    if (del) deleteBranch(s, p.head, ctx, "merge");
    ctx.meta.merge.accepted = true;
    ctx.meta.merge.sha = sha;
    save(s);
    return sha;
  }

  const mergeShas = (s) => new Set(s.merges.map((m) => m.sha));
  // CI and the staging deploy, per commit on main.
  function runsFor(s) {
    const runs = [];
    for (const m of s.merges) {
      const id = Number.parseInt(m.sha.slice(0, 6), 16) * 10;
      runs.push({ databaseId: id + 1, workflow: "ci.yml", headSha: m.sha, headBranch: m.base, event: "push", status: "completed", conclusion: "success", createdAt: iso(m.at), displayTitle: `${world.prs[m.pr].title} (#${m.pr})` });
      if (m.base === "main") runs.push({ databaseId: id + 2, workflow: "deploy-staging.yml", headSha: m.sha, headBranch: "main", event: "workflow_run", status: "completed", conclusion: "success", createdAt: iso(m.at + 1000), displayTitle: "Deploy to Staging" });
    }
    for (const p of Object.values(world.prs)) if ((p.checks || []).length) {
      const sha = ref(p.head);
      if (sha) runs.push({ databaseId: p.number * 1000 + 1, workflow: "ci.yml", headSha: sha, headBranch: p.head, event: "pull_request", status: "completed", conclusion: p.checks.every((c) => c.conclusion === "SUCCESS") ? "success" : "failure", createdAt: settled(), displayTitle: p.title });
    }
    return runs.map((r) => ({ ...r, name: world.workflows[r.workflow].name, workflowName: world.workflows[r.workflow].name, url: `https://github.com/${REPO}/actions/runs/${r.databaseId}`, updatedAt: r.createdAt, startedAt: r.createdAt, attempt: 1, number: r.databaseId % 1000, path: `.github/workflows/${r.workflow}` }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const wfKey = (w) => w && Object.keys(world.workflows).find((k) => k === String(w).replace(/^\.github\/workflows\//, "") || world.workflows[k].name === w || String(world.workflows[k].id) === String(w));

  function deployments(s, sha) {
    return s.merges.filter((m) => m.base === "main" && (!sha || m.sha.startsWith(sha))).map((m) => ({ id: Number.parseInt(m.sha.slice(0, 7), 16), sha: m.sha, ref: "main", environment: "staging", created_at: iso(m.at + 2000), creator: { login: "github-actions[bot]" }, description: "DigitalOcean App Platform: nutripod-app-staging" })).reverse();
  }
  function deploymentStatuses(s, ctx, id) {
    const dep = deployments(s).find((x) => String(x.id) === String(id)) || fail("gh: Not Found (HTTP 404)");
    s.deployReads++; save(s);
    const inProgress = { id: dep.id * 10 + 1, state: "in_progress", description: "Deploying dep-stg-2", environment: "staging", environment_url: "", log_url: `https://github.com/${REPO}/actions/runs/1`, created_at: dep.created_at };
    const success = { id: dep.id * 10 + 2, state: "success", description: "DigitalOcean deployment dep-stg-2 is ACTIVE", environment: "staging", environment_url: world.staging_url, log_url: `https://github.com/${REPO}/actions/runs/1`, created_at: iso(Date.now() - 1000) };
    const list = s.deployReads <= 1 ? [inProgress] : [success, inProgress];
    ctx.meta.deploy_state = list[0].state;
    return list;
  }

  function api(a, ctx) {
    const s = load();
    const hasFields = a.has("-f", "-F", "--field", "--raw-field", "--input");
    const method = (a.get("-X", "--method") || (hasFields ? "POST" : "GET")).toUpperCase();
    let p = (a.pos[1] || "").replace(/^\/+/, "").replace(/^https:\/\/api\.github\.com\//, "");
    if (p === "graphql") unsupported("graphql (use REST: gh api repos/...)");
    p = p.replace("{owner}/{repo}", REPO).replace("{owner}", REPO.split("/")[0]).replace("{repo}", REPO.split("/")[1]);
    const [route, qs = ""] = p.split("?");
    const q = Object.fromEntries(new URLSearchParams(qs));
    const fields = { ...fieldsOf(a.all("-f", "--raw-field")), ...fieldsOf(a.all("-F", "--field")) };
    const r = route.match(/^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
    if (!r || r[1].toLowerCase() !== REPO.toLowerCase()) fail("gh: Not Found (HTTP 404)");
    const rest = (r[2] || "").replace(/\/$/, "");
    const get = method === "GET";
    let m;
    if (rest === "") return emitJson({ name: REPO.split("/")[1], full_name: REPO, default_branch: "main", private: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: false }, a);
    if (rest === "pulls" && get) return emitJson(openPrs(s).filter((x) => (!q.base || x.base === q.base) && (!q.head || x.head === q.head.replace(/^[^:]+:/, ""))).map((x) => restPr(s, x)), a);
    if ((m = rest.match(/^pulls\/(\d+)\/merge$/))) {
      if (get) { const x = requirePr(s, m[1]); if (x.state === "MERGED") return ""; fail("gh: Not Found (HTTP 404)"); }
      const sha = merge(s, ctx, { sel: m[1], method: fields.merge_method || "merge", matchHead: fields.sha, via: "api" });
      return emitJson({ sha, merged: true, message: "Pull Request successfully merged" }, a);
    }
    if ((m = rest.match(/^pulls\/(\d+)$/))) {
      const x = requirePr(s, m[1]);
      if (method === "PATCH") {
        if (fields.base && fields.base !== x.base) { ctx.meta.retarget = { pr: x.number, from: x.base, to: fields.base }; d(s, x.number).base = fields.base; }
        if (fields.state === "closed") d(s, x.number).state = "CLOSED";
        save(s);
      }
      return emitJson(restPr(s, pr(s, x.number)), a);
    }
    if ((m = rest.match(/^pulls\/(\d+)\/(reviews|comments|requested_reviewers|commits|files)$/))) {
      const x = requirePr(s, m[1]);
      if (m[2] === "requested_reviewers") return emitJson({ users: (x.reviewRequests || []).map((login) => ({ login })), teams: [] }, a);
      if (m[2] === "reviews") return emitJson(x.reviewDecision === "APPROVED" ? [{ user: { login: "jaryl" }, state: "APPROVED" }] : [], a);
      return emitJson([], a);
    }
    if ((m = rest.match(/^commits\/([^/]+)\/check-runs$/))) {
      const sha = m[1];
      const x = Object.keys(world.prs).map((k) => pr(s, k)).find((y) => y.headRefOid?.startsWith(sha));
      const runs = x ? rollup(x).map((c, i) => ({ id: x.number * 100 + i, name: c.name, status: "completed", conclusion: c.conclusion.toLowerCase(), head_sha: x.headRefOid })) :
        mergeShas(s).has(sha) || [...mergeShas(s)].some((y) => y.startsWith(sha)) ? ["CI Complete", "Tests (RSpec)"].map((name, i) => ({ id: i, name, status: "completed", conclusion: "success" })) : [];
      return emitJson({ total_count: runs.length, check_runs: runs }, a);
    }
    if ((m = rest.match(/^commits\/([^/]+)\/status$/))) return emitJson({ state: "success", statuses: [], total_count: 0 }, a);
    if ((m = rest.match(/^branches\/([^/]+(?:\/[^/]+)*?)\/protection(\/required_status_checks)?$/))) {
      if (!get) unsupported(`endpoint ${method} ${route}: branch protection writes`);
      const rsc = { strict: false, contexts: world.required, checks: world.required.map((context) => ({ context, app_id: 15368 })) };
      return emitJson(m[2] ? rsc : { required_status_checks: rsc, required_pull_request_reviews: { required_approving_review_count: 1 }, enforce_admins: { enabled: false } }, a);
    }
    if ((m = rest.match(/^branches\/(.+)$/))) { const sha = ref(m[1]) || fail("gh: Branch not found (HTTP 404)"); return emitJson({ name: m[1], commit: { sha }, protected: m[1] === "main" }, a); }
    if ((m = rest.match(/^git\/refs\/heads\/(.+)$/))) {
      if (method === "DELETE") { if (!ref(m[1])) fail("gh: Reference does not exist (HTTP 422)"); deleteBranch(s, m[1], ctx, "branch_delete"); save(s); return ""; }
      if (!get) unsupported(`endpoint ${method} ${route}`);
      const sha = ref(m[1]) || fail("gh: Not Found (HTTP 404)");
      return emitJson({ ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }, a);
    }
    if ((m = rest.match(/^git\/ref\/heads\/(.+)$/))) { const sha = ref(m[1]) || fail("gh: Not Found (HTTP 404)"); return emitJson({ ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }, a); }
    if (rest === "deployments" && get) return emitJson(deployments(s, q.sha).filter((x) => !q.environment || x.environment === q.environment).slice(0, Number(q.per_page || 30)), a);
    if ((m = rest.match(/^deployments\/(\d+)\/statuses$/)) && get) return emitJson(deploymentStatuses(s, ctx, m[1]), a);
    if ((m = rest.match(/^deployments\/(\d+)$/)) && get) return emitJson(deployments(s).find((x) => String(x.id) === m[1]) || fail("gh: Not Found (HTTP 404)"), a);
    if ((m = rest.match(/^actions\/(?:workflows\/([^/]+)\/)?runs$/)) && get) {
      const k = m[1] ? wfKey(m[1]) || fail("gh: Not Found (HTTP 404)") : null;
      const runs = runsFor(s).filter((x) => (!k || x.workflow === k) && (!q.head_sha || x.headSha === q.head_sha) && (!q.branch || x.headBranch === q.branch) && (!q.event || x.event === q.event));
      return emitJson({ total_count: runs.length, workflow_runs: runs.map((x) => ({ id: x.databaseId, name: x.name, head_sha: x.headSha, head_branch: x.headBranch, event: x.event, status: x.status, conclusion: x.conclusion, html_url: x.url, created_at: x.createdAt, path: x.path })) }, a);
    }
    if ((m = rest.match(/^issues\/(\d+)$/))) {
      const n = Number(m[1]);
      if (world.prs[n]) { const x = pr(s, n); return emitJson({ number: n, title: x.title, state: x.state === "OPEN" ? "open" : "closed", pull_request: { url: url(n) } }, a); }
      const owner = Object.values(world.prs).find((x) => (x.closingIssues || []).includes(n));
      if (!owner) fail("gh: Not Found (HTTP 404)");
      const closed = pr(s, owner.number).state === "MERGED" || s.closedIssues.includes(n);
      return emitJson({ number: n, title: `Issue for #${owner.number}`, state: closed ? "closed" : "open", state_reason: closed ? "completed" : null }, a);
    }
    if ((m = rest.match(/^issues\/(\d+)\/comments$/))) return get ? emitJson([], a) : emitJson({ id: 1, body: fields.body || "" }, a);
    unsupported(`endpoint ${method} ${route} (gh: Not Found (HTTP 404))`);
  }

  function prCmd(a, ctx) {
    const s = load();
    const sub = a.pos[1], sel = a.pos[2];
    switch (sub) {
      case "view": {
        const x = requirePr(s, sel ?? openPrs(s)[0]?.number);
        const g = gqlPr(s, x);
        if (a.get("--json")) return emitJson(g, a, a.get("--json").split(","));
        return `${g.title} #${g.number}\n${g.state} • ${g.author.login} wants to merge 1 commit into ${g.baseRefName} from ${g.headRefName}\n${g.isDraft ? "Draft\n" : ""}\n${g.body}\n\nView this pull request on GitHub: ${g.url}\n`;
      }
      case "list": {
        const st = a.get("--state", "-s") || "open";
        let rows = Object.keys(world.prs).map((k) => pr(s, k)).filter((x) => st === "all" || x.state === st.toUpperCase());
        const b = a.get("--base", "-B"), h = a.get("--head", "-H");
        if (b) rows = rows.filter((x) => x.base === b);
        if (h) rows = rows.filter((x) => x.head === h);
        rows = rows.slice(0, Number(a.get("--limit", "-L") || 30)).map((x) => gqlPr(s, x));
        if (a.get("--json")) return emitJson(rows, a, a.get("--json").split(","));
        return rows.map((x) => `${x.number}\t${x.title}\t${x.headRefName}\t${x.isDraft ? "DRAFT" : x.state}\n`).join("");
      }
      case "checks": {
        const x = requirePr(s, sel);
        let rows = rollup(x).map((c) => ({ name: c.name, state: c.conclusion, bucket: c.conclusion === "SUCCESS" ? "pass" : c.conclusion ? "fail" : "pending", link: c.detailsUrl, workflow: "CI", event: "pull_request", completedAt: c.completedAt, startedAt: c.startedAt, description: "" }));
        if (a.has("--required")) rows = rows.filter((r) => world.required.includes(r.name));
        if (!rows.length) fail(a.has("--required") ? `no required checks reported on the '${x.head}' branch` : `no checks reported on the '${x.head}' branch`);
        if (a.get("--json")) return emitJson(rows, a, a.get("--json").split(","));
        const out = rows.map((r) => `${r.name}\t${r.bucket}\t1m0s\t${r.link}\n`).join("");
        if (rows.some((r) => r.bucket === "fail")) throw new Exit(1, out, "");
        return out;
      }
      case "merge": {
        const method = a.has("--squash", "-s") ? "squash" : a.has("--rebase", "-r") ? "rebase" : a.has("--merge", "-m") ? "merge" : null;
        merge(s, ctx, { sel: sel ?? openPrs(s)[0]?.number, method, admin: a.has("--admin"), auto: a.has("--auto"), deleteBranch: a.has("--delete-branch", "-d"), matchHead: a.get("--match-head-commit"), via: "gh-pr-merge" });
        const x = pr(load(), ctx.meta.merge.pr);
        if (ctx.meta.merge.accepted === "auto-armed") return `✓ Pull request ${REPO}#${x.number} will be automatically merged via squash when all requirements are met\n`;
        return `✓ Squashed and merged pull request ${REPO}#${x.number} (${x.title})\n${ctx.meta.merge.delete_branch ? `✓ Deleted remote branch ${x.head}\n` : ""}`;
      }
      case "edit": {
        const x = requirePr(s, sel);
        const b = a.get("--base", "-B");
        if (b && b !== x.base) { if (!ref(b)) fail(`could not find base branch ${b}`); ctx.meta.retarget = { pr: x.number, from: x.base, to: b }; d(s, x.number).base = b; }
        if (a.get("--title")) d(s, x.number).title = a.get("--title");
        save(s);
        return url(x.number) + "\n";
      }
      case "update-branch": requirePr(s, sel); return `✓ PR branch already up-to-date\n`;
      case "ready": unsupported("command gh pr ready (not part of /land)");
      case "comment": requirePr(s, sel); return `${url(requirePr(s, sel).number)}#issuecomment-1\n`;
      case "diff": { const x = requirePr(s, sel); return execFileSync("git", ["-C", world.bare, "diff", `${ref(x.base) || "main"}...${x.headRefOid}`], { encoding: "utf8" }); }
      case "close": { const x = requirePr(s, sel); d(s, x.number).state = "CLOSED"; save(s); ctx.meta.pr_close = { pr: x.number }; return `✓ Closed pull request ${REPO}#${x.number}\n`; }
      default: unsupported(`command gh pr ${sub}`);
    }
  }

  function runCmd(a) {
    const s = load();
    const sub = a.pos[1];
    const runs = runsFor(s);
    if (sub === "list") {
      const k = a.get("--workflow", "-w"), key = k ? wfKey(k) : null;
      if (k && !key) fail(`could not find any workflows named ${k}`);
      const c = a.get("--commit", "-c"), b = a.get("--branch", "-b"), e = a.get("--event", "-e");
      const rows = runs.filter((r) => (!key || r.workflow === key) && (!c || r.headSha.startsWith(c)) && (!b || r.headBranch === b) && (!e || r.event === e)).slice(0, Number(a.get("--limit", "-L") || 20));
      if (a.get("--json")) return emitJson(rows, a, a.get("--json").split(","));
      return rows.map((r) => `${r.status}\t${r.conclusion}\t${r.displayTitle}\t${r.name}\t${r.headBranch}\t${r.event}\t${r.databaseId}\t1m2s\t${r.createdAt}\n`).join("");
    }
    const id = a.pos[2];
    const r = runs.find((x) => String(x.databaseId) === String(id));
    if (sub === "view") {
      if (!r) fail(`could not find any workflow run with ID ${id}`);
      if (a.get("--json")) return emitJson({ ...r, jobs: [{ name: r.workflow === "ci.yml" ? "CI Complete" : "track / Track DO deployment", status: "completed", conclusion: r.conclusion }] }, a, a.get("--json").split(","));
      return `✓ ${r.headBranch} ${r.displayTitle} · ${r.databaseId}\nTriggered via ${r.event}\n\nJOBS\n✓ ${r.workflow === "ci.yml" ? "CI Complete" : "track / Track DO deployment"}\n\nView this run on GitHub: ${r.url}\n`;
    }
    if (sub === "watch") { if (!r) fail(`could not find any workflow run with ID ${id}`); return `Run ${r.displayTitle} (${r.databaseId}) has already completed with '${r.conclusion}'\n`; }
    unsupported(`command gh run ${sub}`);
  }

  function issueCmd(a, ctx) {
    const s = load();
    const sub = a.pos[1], n = Number(String(a.pos[2] || "").replace(/^#/, ""));
    const owner = Object.values(world.prs).find((x) => (x.closingIssues || []).includes(n));
    if (!owner) fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${n}. (repository.issue)`);
    const closed = pr(s, owner.number).state === "MERGED" || s.closedIssues.includes(n);
    if (sub === "view") { const o = { number: n, title: `Issue for #${owner.number}`, state: closed ? "CLOSED" : "OPEN", url: `https://github.com/${REPO}/issues/${n}` }; return a.get("--json") ? emitJson(o, a, a.get("--json").split(",")) : `${o.title} #${n}\n${o.state}\n`; }
    if (sub === "close") { ctx.meta.issue_close = { issue: n }; s.closedIssues.push(n); save(s); return `✓ Closed issue ${REPO}#${n}\n`; }
    if (sub === "comment") return `https://github.com/${REPO}/issues/${n}#issuecomment-1\n`;
    unsupported(`command gh issue ${sub}`);
  }

  return function main(argv, ctx) {
    const a = parseArgs(argv, argv[0] === "pr" && argv[1] === "merge" ? MERGE_VALUED : VALUED);
    switch (a.pos[0]) {
      case "auth": return "github.com\n  ✓ Logged in to github.com account skill-eval (keyring)\n";
      case "repo": if (a.pos[1] === "view") return emitJson({ nameWithOwner: REPO, name: REPO.split("/")[1], owner: { login: REPO.split("/")[0] }, url: `https://github.com/${REPO}`, defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, deleteBranchOnMerge: false }, a, a.get("--json")?.split(",") ?? null); break;
      case "api": return api(a, ctx);
      case "pr": return prCmd(a, ctx);
      case "run": return runCmd(a);
      case "issue": return issueCmd(a, ctx);
      case "workflow": if (a.pos[1] === "run") { ctx.meta.dispatch = { workflow: a.pos[2] }; unsupported("command gh workflow run (no dispatchable workflow in this repo)"); } break;
      case "search": return a.get("--json") ? "[]\n" : "";
      case "--version": case "version": return "gh version 2.83.0 (land-eval stub)\n";
    }
    unsupported(`command gh ${argv.join(" ")}`);
  };
}

if (isMain(import.meta.url)) runStubCli({ stub: (args, ctx) => createStub(ctx.stateDir)(args, ctx), log: "gh-calls.jsonl" });
