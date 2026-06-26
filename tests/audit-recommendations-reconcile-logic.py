#!/usr/bin/env python3
"""Logic tests for the actions-audit noise-control + reconcile changes.

Self-contained, no network: loads recommendations.py / open_issues.py directly,
feeds synthetic findings, and asserts the issue-worthy/digest split, org-shared
coalescing, and the reconcile pass's safety rails (marker-scoped + scanned-scoped).
Run: `python3 tests/audit-recommendations-reconcile-logic.py` (exits non-zero on
failure). Not wired into PR CI yet — see the PR for the follow-up suggestion.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rec = _load("recommendations", "audit/recommendations.py")
oi = _load("open_issues", "audit/open_issues.py")


def wf(repo, name, **kw):
    base = dict(repo=repo, name=name, path=f".github/workflows/{name.lower().replace(' ', '-')}.yml",
                runs=20, failure=0, failed_minutes=0, failure_rate=0.0,
                cancelled=0, cancel_rate=0.0, cancelled_minutes=0,
                flake_count=0, total_minutes=10, avg_minutes=1, p95_minutes=2)
    base.update(kw)
    return base


def test_split_thresholds():
    # No gh precheck for concurrency in tests.
    rec.gh_raw_workflow = lambda r, p: None
    data = {"generated_at": "t", "window_days": 7, "scope": "all", "workflows": [
        # issue-worthy: failed-minutes over both bars
        wf("nutripod-web", "CI", runs=40, failure=25, failed_minutes=120, failure_rate=0.62, total_minutes=50),
        # digest: failed-minutes below bars
        wf("jumpdrive-web", "CI", runs=30, failure=4, failed_minutes=12, failure_rate=0.13, total_minutes=40),
        # issue-worthy: concurrency (always)
        wf("rarebit-static-v3", "Deploy", cancelled=6, cancel_rate=0.30, cancelled_minutes=40, total_minutes=30),
        # issue-worthy: flakes >= 3
        wf("standard_health", "Nightly", flake_count=5, total_minutes=20),
    ]}
    out = rec.partition(data)
    j = {f"{x['repo']}/{x['category']}" for x in out["judgment"]}
    assert j == {"nutripod-web/failed-minutes", "rarebit-static-v3/concurrency",
                 "standard_health/flakes"}, j
    d = {f"{x['repo']}/{x['category']}" for x in out["digest"]}
    assert "jumpdrive-web/failed-minutes" in d, d
    assert out["scanned_repos"] == sorted(
        {"nutripod-web", "jumpdrive-web", "rarebit-static-v3", "standard_health"}), out["scanned_repos"]
    print("split/thresholds/scanned_repos OK")


def test_coalesce_shared():
    rec.gh_raw_workflow = lambda r, p: None
    data = {"generated_at": "t", "window_days": 7, "scope": "all", "workflows": [
        wf("nutripod-web", "Claude Code Review", flake_count=1),
        wf("jumpdrive-web", "Claude Code Review", flake_count=2),
        wf("rarebit-static-v3", "Claude Code Review", flake_count=1),
    ]}
    out = rec.partition(data)
    flake_digest = [x for x in out["digest"] if x["category"] == "flakes"]
    assert len(flake_digest) == 1, flake_digest          # 3 repos -> 1 coalesced row
    assert flake_digest[0]["coalesced_repos"] == ["jumpdrive-web", "nutripod-web", "rarebit-static-v3"]
    print("org-shared coalescing OK")


def test_reconcile_rails():
    closed = []
    oi.close_issue = lambda n, c: (closed.append(n) or True)
    oi.list_open_ci_audit_issues = lambda: [
        {"number": 101, "body": "<!-- ci-target repo=rarebit-one/nutripod-web workflow=x category=flakes -->\n<!-- actions-audit:a1a1a1a1a1a1 -->"},
        {"number": 102, "body": "<!-- ci-target repo=rarebit-one/nutripod-web workflow=x category=concurrency -->\n<!-- actions-audit:b2b2b2b2b2b2 -->"},
        {"number": 103, "body": "human-filed, no marker"},
        {"number": 104, "body": "<!-- ci-target repo=rarebit-one/unscanned-repo workflow=x category=flakes -->\n<!-- actions-audit:c3c3c3c3c3c3 -->"},
    ]
    n = oi.reconcile({"b2b2b2b2b2b2"}, {"nutripod-web", "jumpdrive-web"}, "http://run/1")
    assert closed == [101], closed   # only cleared + scanned + marker-bearing
    assert n == 1, n
    print("reconcile safety rails OK")


if __name__ == "__main__":
    test_split_thresholds()
    test_coalesce_shared()
    test_reconcile_rails()
    print("ALL TESTS PASSED")
