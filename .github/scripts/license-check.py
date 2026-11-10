#!/usr/bin/env python3
"""Check third-party licences in a repo's lockfiles against the org policy.

Reads lockfiles only; nothing is installed or built:
  npm       package-lock.json / npm-shrinkwrap.json (v2/v3): the `license` field npm records
  RubyGems  Gemfile.lock: licences from the rubygems.org API for each exact version
  Go        go.mod requirements (the resolved build list): licences from the deps.dev API

Each dependency gets one verdict: allow, warn (review) or block. Packages owned by
the caller's org are first-party and are listed, not judged. Exceptions in the policy
(org default plus an optional `.github/license-policy.json` in the scanned repo)
downgrade a verdict to allow and must carry a reason.

Report mode always exits 0. Enforce mode exits 1 when anything is blocked.

Usage:
  license-check.py --root DIR [--policy FILE] [--extra-policy FILE] [--owner ORG]
                   [--mode report|enforce] [--summary FILE] [--json FILE]
                   [--offline-licences FILE]
"""
import argparse
import concurrent.futures
import fnmatch
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SKIP_DIRS = {".git", "node_modules", "vendor", ".worktrees", "testdata", "tmp", "dist", "build", ".bundle"}
RANK = {"allow": 0, "warn": 1, "block": 2}
USER_AGENT = "rarebit-one-license-check"


# ---------------------------------------------------------------- lockfiles

def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read_lines(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read().splitlines(keepends=True)


def find_lockfiles(root):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for f in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, f), root)
            if f in ("package-lock.json", "npm-shrinkwrap.json"):
                found.append(("npm", rel))
            elif f == "Gemfile.lock":
                found.append(("rubygems", rel))
            elif f == "go.mod":
                found.append(("go", rel))
            elif f in ("yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "gradle.lockfile", "Cargo.lock", "poetry.lock", "uv.lock"):
                found.append(("unsupported", rel))
    return found


def parse_npm(path):
    lock = read_json(path)
    out = []
    for key, meta in (lock.get("packages") or {}).items():
        if not key or meta.get("link"):
            continue
        if "node_modules/" not in key:  # a workspace package, not a dependency
            continue
        name = meta.get("name") or key.rsplit("node_modules/", 1)[-1]
        out.append({"name": name, "version": meta.get("version"), "dev": bool(meta.get("dev")),
                    "licence": meta.get("license"), "licence_source": "package-lock license field"})
    uniq = {}
    for d in out:
        k = (d["name"], d["version"])
        if k in uniq:
            uniq[k]["dev"] = uniq[k]["dev"] and d["dev"]
        else:
            uniq[k] = d
    return list(uniq.values())


SPEC_RE = re.compile(r"^    ([^ (]+) \(([^)]+)\)$")


def parse_gemfile_lock(path):
    out, section = [], None
    for line in read_lines(path):
        line = line.rstrip("\n")
        if line and not line.startswith(" "):
            section = line.strip()
            continue
        m = SPEC_RE.match(line)
        if not m or section not in ("GEM", "PATH", "GIT"):
            continue
        name, version = m.group(1), m.group(2)
        # Platform gems lock as "1.18.9-arm64-darwin"; the licence belongs to the version.
        base = re.match(r"^([0-9][0-9A-Za-z.]*)", version)
        out.append({"name": name, "version": base.group(1) if base else version,
                    "first_party_source": section in ("PATH", "GIT") or None})
    uniq = {}
    for d in out:
        uniq.setdefault((d["name"], d["version"]), d)
    return list(uniq.values())


def parse_go_mod(path):
    out, in_block = [], False
    replaced_local = set()
    for raw in read_lines(path):
        indirect = "// indirect" in raw
        line = raw.split("//", 1)[0].strip()
        if line.startswith("replace ") and "=>" in line:
            left, right = line[len("replace "):].split("=>", 1)
            if right.strip().startswith((".", "/")):
                replaced_local.add(left.split()[0])
            continue
        if line == "require (":
            in_block = True
            continue
        if in_block and line == ")":
            in_block = False
            continue
        parts = None
        if in_block and line:
            parts = line.split()
        elif line.startswith("require ") and "(" not in line:
            parts = line[len("require "):].split()
        if parts and len(parts) >= 2:
            out.append({"name": parts[0], "version": parts[1], "indirect": indirect})
    for d in out:
        if d["name"] in replaced_local:
            d["first_party_source"] = True
    return out


# ---------------------------------------------------------------- licence lookup

class Lookup:
    def __init__(self, offline=None, pause=0.05):
        self.offline = offline
        self.pause = pause
        self.cache = {}

    def _get_json(self, url):
        err = "retries exhausted"
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=20) as r:
                    return json.load(r), None
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None, "not found"
                if e.code == 429 or e.code >= 500:
                    err = f"HTTP {e.code}"
                    time.sleep(2 * (attempt + 1))
                    continue
                return None, f"HTTP {e.code}"
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                err = str(e)
                time.sleep(1 + attempt)
        return None, f"lookup failed ({err})"

    def rubygems(self, name, version):
        key = f"rubygems:{name}@{version}"
        if self.offline is not None:
            return self.offline.get(key), "offline fixture"
        if key not in self.cache:
            time.sleep(self.pause)
            url = f"https://rubygems.org/api/v2/rubygems/{urllib.parse.quote(name)}/versions/{urllib.parse.quote(version)}.json"
            data, err = self._get_json(url)
            if data is None:
                self.cache[key] = (None, f"rubygems.org: {err}")
            else:
                lic = data.get("licenses") or []
                # A gemspec licence list is a choice (e.g. ["Ruby", "BSD-2-Clause"]).
                self.cache[key] = (" OR ".join(f"({x})" if " " in x else x for x in lic) or None, "rubygems.org")
        return self.cache[key]

    def go(self, name, version):
        key = f"go:{name}@{version}"
        if self.offline is not None:
            return self.offline.get(key), "offline fixture"
        if key not in self.cache:
            time.sleep(self.pause)
            url = ("https://api.deps.dev/v3/systems/go/packages/" + urllib.parse.quote(name, safe="")
                   + "/versions/" + urllib.parse.quote(version, safe=""))
            data, err = self._get_json(url)
            if data is None:
                self.cache[key] = (None, f"deps.dev: {err}")
            else:
                lic = [x for x in (data.get("licenses") or []) if x and x != "non-standard"]
                if "non-standard" in (data.get("licenses") or []):
                    lic.append("NON-STANDARD")
                # deps.dev lists every licence found in the module: all of them apply.
                self.cache[key] = (" AND ".join(f"({x})" if " " in x else x for x in lic) or None, "deps.dev")
        return self.cache[key]


# ---------------------------------------------------------------- policy

def tokenize(expr):
    return re.findall(r"\(|\)|[^\s()]+", expr)


def parse_expr(tokens):
    """Tiny SPDX-ish parser: OR binds looser than AND; WITH stays on its licence."""
    pos = 0

    def atom():
        nonlocal pos
        if pos < len(tokens) and tokens[pos] == "(":
            pos += 1
            node = or_expr()
            if pos < len(tokens) and tokens[pos] == ")":
                pos += 1
            return node
        words = []
        while pos < len(tokens) and tokens[pos] not in ("(", ")") and tokens[pos].upper() not in ("AND", "OR"):
            words.append(tokens[pos])
            pos += 1
        return ("id", " ".join(words))

    def and_expr():
        nonlocal pos
        node = atom()
        while pos < len(tokens) and tokens[pos].upper() == "AND":
            pos += 1
            node = ("and", node, atom())
        return node

    def or_expr():
        nonlocal pos
        node = and_expr()
        while pos < len(tokens) and tokens[pos].upper() == "OR":
            pos += 1
            node = ("or", node, and_expr())
        return node

    return or_expr()


def classify_id(lid, policy):
    s = lid.strip()
    low = s.lower()
    base = re.sub(r"\s+with\s+.*$", "", low)  # "Apache-2.0 WITH LLVM-exception" → apache-2.0
    for pat in policy["block"]:
        if fnmatch.fnmatch(base, pat.lower()) or fnmatch.fnmatch(low, pat.lower()):
            return "block", f"{s}: blocked licence"
    for pat in policy["warn"]:
        if fnmatch.fnmatch(base, pat.lower()):
            return "warn", f"{s}: copyleft, review"
    for pat in policy["allow"]:
        if base == pat.lower() or fnmatch.fnmatch(base, pat.lower()):
            return "allow", s
    if low.startswith("see licen") or low in ("unlicensed", "proprietary", "non-standard", "unknown", "custom"):
        return "warn", f"{s}: no standard licence, review"
    return "warn", f"{s}: not on the allow list, review"


def evaluate(node, policy):
    kind = node[0]
    if kind == "id":
        if not node[1]:
            return "warn", "empty licence"
        return classify_id(node[1], policy)
    a, b = evaluate(node[1], policy), evaluate(node[2], policy)
    if kind == "or":
        return min(a, b, key=lambda v: RANK[v[0]])
    worst = max(a, b, key=lambda v: RANK[v[0]])
    return worst


def judge(licence, policy):
    if licence is None or (isinstance(licence, str) and not licence.strip()):
        return "warn", "no detectable licence, review"
    if isinstance(licence, dict):  # very old npm `license: {type, url}`
        licence = licence.get("type") or ""
    return evaluate(parse_expr(tokenize(str(licence))), policy)


def load_policy(path, extra_path=None):
    pol = read_json(path)
    pol.setdefault("exceptions", [])
    pol.setdefault("first_party", [])
    if extra_path and os.path.isfile(extra_path):
        extra = read_json(extra_path)
        for e in extra.get("exceptions", []):
            if not str(e.get("reason", "")).strip():
                raise SystemExit(f"{extra_path}: every exception needs a reason ({e})")
            e = dict(e, origin="repo")
            pol["exceptions"].append(e)
        pol["first_party"] += extra.get("first_party", [])
    for e in pol["exceptions"]:
        if not str(e.get("reason", "")).strip():
            raise SystemExit(f"{path}: every exception needs a reason ({e})")
    return pol


def first_party(eco, name, owner, policy, dep):
    if dep.get("first_party_source"):
        return True
    pats = list(policy["first_party"])
    if owner:
        o = owner.lower()
        pats += {"npm": [f"@{o}/*"], "go": [f"github.com/{o}/*"], "rubygems": []}.get(eco, [])
    return any(fnmatch.fnmatch(name.lower(), p.lower()) for p in pats if p)


def find_exception(eco, name, policy):
    for e in policy["exceptions"]:
        if e.get("ecosystem") in (eco, "*", None) and fnmatch.fnmatch(name, e["name"]):
            return e
    return None


# ---------------------------------------------------------------- run

def scan(root, policy, owner, lookup, workers=4):
    results, notes = [], []
    lockfiles = find_lockfiles(root)
    jobs = []
    for eco, rel in lockfiles:
        path = os.path.join(root, rel)
        if eco == "unsupported":
            notes.append(f"`{rel}`: lockfile format not supported, not checked")
            continue
        try:
            deps = {"npm": parse_npm, "rubygems": parse_gemfile_lock, "go": parse_go_mod}[eco](path)
        except (OSError, ValueError, KeyError) as e:
            notes.append(f"`{rel}`: could not parse ({e})")
            continue
        for d in deps:
            jobs.append((eco, rel, d))

    def resolve(job):
        eco, rel, d = job
        r = {"ecosystem": eco, "lockfile": rel, "name": d["name"], "version": d["version"],
             "dev": d.get("dev"), "indirect": d.get("indirect")}
        if first_party(eco, d["name"], owner, policy, d):
            r.update(verdict="first-party", licence=None, reason="owned by this org, not judged")
            return r
        if eco == "npm":
            lic, src = d.get("licence"), d.get("licence_source")
        elif eco == "rubygems":
            lic, src = lookup.rubygems(d["name"], d["version"])
        else:
            lic, src = lookup.go(d["name"], d["version"])
        exc = find_exception(eco, d["name"], policy)
        if exc and exc.get("licence"):
            lic, src = exc["licence"], f"policy override ({exc['reason']})"
        verdict, reason = judge(lic, policy)
        if src and src.startswith(("rubygems.org:", "deps.dev:")):
            verdict, reason = "warn", f"{src}, review"
        if exc and verdict != "allow" and not exc.get("licence"):
            r["exception"] = exc["reason"]
            reason = f"{reason} (excepted: {exc['reason']})"
            verdict = "allow"
        r.update(verdict=verdict, licence=lic, licence_source=src, reason=reason)
        return r

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(resolve, jobs))
    return results, notes, lockfiles


def md_escape(s):
    return str(s if s is not None else "—").replace("|", "\\|").replace("\n", " ")


def render_summary(results, notes, lockfiles, mode, policy_desc):
    counts = {k: 0 for k in ("block", "warn", "allow", "first-party")}
    for r in results:
        counts[r["verdict"]] += 1
    excepted = [r for r in results if r.get("exception")]
    lines = ["## Licence check", ""]
    head = (f"**{counts['block']} blocked · {counts['warn']} to review · {counts['allow']} allowed"
            f" ({len(excepted)} by exception) · {counts['first-party']} first-party**")
    lines += [head, "", f"Mode: `{mode}`. Lockfiles: {len([l for l in lockfiles if l[0] != 'unsupported'])}. Policy: {policy_desc}.", ""]
    for verdict, title in (("block", "Blocked"), ("warn", "To review")):
        rows = sorted((r for r in results if r["verdict"] == verdict),
                      key=lambda r: (r["lockfile"], r["name"], str(r["version"])))
        if not rows:
            continue
        lines += [f"### {title} ({len(rows)})", "", "| Package | Version | Licence | Lockfile | Why |", "|---|---|---|---|---|"]
        for r in rows:
            name = r["name"] + (" (dev)" if r.get("dev") else "")
            lines.append(f"| `{md_escape(name)}` | {md_escape(r['version'])} | {md_escape(r.get('licence'))} | `{md_escape(r['lockfile'])}` | {md_escape(r['reason'])} |")
        lines.append("")
    if excepted:
        lines += [f"### Allowed by recorded exception ({len(excepted)})", "", "| Package | Version | Licence | Reason |", "|---|---|---|---|"]
        for r in sorted(excepted, key=lambda r: r["name"]):
            lines.append(f"| `{md_escape(r['name'])}` | {md_escape(r['version'])} | {md_escape(r.get('licence'))} | {md_escape(r['exception'])} |")
        lines.append("")
    if notes:
        lines += ["### Not checked", ""] + [f"- {n}" for n in notes] + [""]
    if not lockfiles:
        lines += ["No supported lockfile found.", ""]
    return "\n".join(lines), counts


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".")
    ap.add_argument("--policy", default=os.path.join(here, "license-policy.json"))
    ap.add_argument("--extra-policy", help="repo policy additions (default: <root>/.github/license-policy.json)")
    ap.add_argument("--owner", default=os.environ.get("GITHUB_REPOSITORY_OWNER", ""))
    ap.add_argument("--mode", choices=("report", "enforce"), default="report")
    ap.add_argument("--summary", help="append the markdown report here (e.g. $GITHUB_STEP_SUMMARY)")
    ap.add_argument("--json", help="write every verdict here")
    ap.add_argument("--offline-licences", help="JSON map 'eco:name@version' → licence; no network (tests)")
    a = ap.parse_args(argv)

    extra = a.extra_policy or os.path.join(a.root, ".github", "license-policy.json")
    policy = load_policy(a.policy, extra)
    offline = read_json(a.offline_licences) if a.offline_licences else None
    results, notes, lockfiles = scan(a.root, policy, a.owner, Lookup(offline))
    desc = "org default" + (" + repo `.github/license-policy.json`" if os.path.isfile(extra) else "")
    md, counts = render_summary(results, notes, lockfiles, a.mode, desc)
    if a.summary:
        with open(a.summary, "a", encoding="utf-8") as fh:
            fh.write(md + "\n")
    else:
        print(md)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump({"counts": counts, "notes": notes, "results": results}, fh, indent=1)
    print(f"licence check: {counts['block']} blocked, {counts['warn']} to review, {counts['allow']} allowed, "
          f"{counts['first-party']} first-party", file=sys.stderr)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # Annotate blocks only; reviews live in the job summary so a large lockfile can't bury them.
        level = "error" if a.mode == "enforce" else "warning"
        for r in results:
            if r["verdict"] == "block":
                print(f"::{level} file={r['lockfile']}::{r['name']}@{r['version']}: {r['reason']}")
    return 1 if (a.mode == "enforce" and counts["block"]) else 0


if __name__ == "__main__":
    sys.exit(main())
