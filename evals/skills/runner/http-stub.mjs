#!/usr/bin/env node
// http-stub.mjs — a `curl` that answers scripted URLs and resolves nothing else.
//
// Health checks are part of most deploy skills, and the agent writes them many
// ways (`curl -fsS URL`, `curl -s -o /dev/null -w '%{http_code}' URL`, `-i`,
// `| jq .status`), so this models the curl options that change what comes back
// rather than matching argv strings. The answers live in <state>/http.json:
//
//   { "https://app.example.invalid/health/ready": { "status": 200, "body": "{…}",
//       "headers": { "content-type": "application/json" } } }
//
// Any other URL fails as unresolvable (exit 6), as the `.invalid` hosts the
// scenarios use would for a real curl. Calls go to <state>/tool-calls.jsonl.
import fs from "node:fs";
import path from "node:path";
import { Exit, runStubCli, isMain } from "./stub-core.mjs";

const VALUED = new Set(["-o", "--output", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-H", "--header", "-X", "--request", "-A", "--user-agent", "-u", "--user", "-d", "--data", "--data-raw", "--retry", "--retry-delay", "--retry-max-time", "-e", "--referer", "-b", "--cookie", "-K", "--config"]);
const REASON = { 200: "OK", 204: "No Content", 301: "Moved Permanently", 302: "Found", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };

export function curlAnswer(routes, args) {
  const o = { fail: false, include: false, head: false, silent: false, showError: false, output: null, writeOut: null, urls: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && a.includes("=")) { const [k, v] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]; if (k === "--output") o.output = v; if (k === "--write-out") o.writeOut = v; continue; }
    if (VALUED.has(a)) { const v = args[++i]; if (a === "-o" || a === "--output") o.output = v; if (a === "-w" || a === "--write-out") o.writeOut = v; continue; }
    if (a === "--fail" || a === "--fail-with-body") { o.fail = true; continue; }
    if (a === "--include") { o.include = true; continue; }
    if (a === "--head") { o.head = true; continue; }
    if (a === "--silent") { o.silent = true; continue; }
    if (a === "--show-error") { o.showError = true; continue; }
    if (/^-[a-zA-Z]+$/.test(a)) {
      for (const c of a.slice(1)) { if (c === "f") o.fail = true; if (c === "i") o.include = true; if (c === "I") o.head = true; if (c === "s") o.silent = true; if (c === "S") o.showError = true; }
      // a combined short flag ending in a valued option (`-so FILE`, `-sw FMT`)
      const last = a[a.length - 1];
      if (last === "o") o.output = args[++i]; else if (last === "w") o.writeOut = args[++i]; else if (last === "m" || last === "H" || last === "X") i++;
      continue;
    }
    if (!a.startsWith("-")) o.urls.push(a);
  }
  if (!o.urls.length) return { exit: 2, out: "", err: "curl: no URL specified\n" };
  const url = o.urls[0];
  const r = routes[url] || routes[url.replace(/\/$/, "")];
  const errOut = (code, msg) => ({ exit: code, out: o.writeOut ? fmt(o.writeOut, { status: 0 }) : "", err: !o.silent || o.showError ? `curl: (${code}) ${msg}\n` : "" });
  if (!r) return { ...errOut(6, `Could not resolve host: ${url.replace(/^\w+:\/\//, "").split(/[/:?]/)[0]}`), url };
  const status = r.status ?? 200;
  const headers = { "content-type": "application/json; charset=utf-8", ...(r.headers || {}) };
  const head = `HTTP/2 ${status} ${REASON[status] || ""}`.trimEnd() + "\r\n" + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";
  if (o.fail && status >= 400) return { ...errOut(22, `The requested URL returned error: ${status}`), url, status };
  let body = o.head ? head : (o.include ? head : "") + (r.body ?? "");
  let out = "";
  if (o.output && o.output !== "-") { if (o.output !== "/dev/null") fs.writeFileSync(o.output, body); } else out += body;
  if (o.writeOut) out += fmt(o.writeOut, { status, size: Buffer.byteLength(r.body ?? "") });
  return { exit: 0, out, err: "", url, status };
}

function fmt(w, { status, size = 0 }) {
  return String(w).replaceAll("%{http_code}", String(status).padStart(3, "0")).replaceAll("%{response_code}", String(status))
    .replaceAll("%{time_total}", "0.042").replaceAll("%{size_download}", String(size)).replaceAll("\\n", "\n");
}

export function httpStub(args, ctx) {
  const routes = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, "http.json"), "utf8"));
  const a = curlAnswer(routes, args);
  ctx.meta.url = a.url ?? null;
  ctx.meta.status = a.status ?? null;
  if (a.exit !== 0) throw new Exit(a.exit, a.out, a.err);
  return a.out;
}

if (isMain(import.meta.url)) runStubCli({ stub: httpStub, log: "tool-calls.jsonl" });
