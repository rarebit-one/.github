#!/usr/bin/env python3
"""Pins .github/scripts/license-check.py against offline fixtures (no network).

Run: python3 tests/license-check.test.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".github", "scripts", "license-check.py")
POLICY = os.path.join(ROOT, ".github", "scripts", "license-policy.json")
FIX = os.path.join(ROOT, "tests", "fixtures", "license-check")

spec = importlib.util.spec_from_file_location("license_check", SCRIPT)
lc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lc)


def run(mode="report", extra_policy=None):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "r.json")
        summary = os.path.join(tmp, "s.md")
        args = [sys.executable, SCRIPT, "--root", FIX, "--owner", "rarebit-one", "--mode", mode,
                "--offline-licences", os.path.join(FIX, "offline-licences.json"),
                "--json", out, "--summary", summary]
        if extra_policy:
            args += ["--extra-policy", extra_policy]
        env = dict(os.environ, GITHUB_ACTIONS="")
        proc = subprocess.run(args, capture_output=True, text=True, env=env)
        with open(out) as fh:
            report = json.load(fh)
        with open(summary) as fh:
            md = fh.read()
        return proc.returncode, {(r["ecosystem"], r["name"]): r for r in report["results"]}, md, report


class Policy(unittest.TestCase):
    pol = lc.load_policy(POLICY)

    def verdict(self, expr):
        return lc.judge(expr, self.pol)[0]

    def test_expressions(self):
        self.assertEqual(self.verdict("MIT"), "allow")
        self.assertEqual(self.verdict("(MPL-2.0 OR Apache-2.0)"), "allow")
        self.assertEqual(self.verdict("GPL-3.0 OR PROPRIETARY"), "warn")
        self.assertEqual(self.verdict("Apache-2.0 AND LGPL-3.0-or-later"), "warn")
        self.assertEqual(self.verdict("MIT AND AGPL-3.0-only"), "block")
        self.assertEqual(self.verdict("AGPL-3.0 OR MIT"), "allow")
        self.assertEqual(self.verdict("Apache-2.0 WITH LLVM-exception"), "allow")
        self.assertEqual(self.verdict("FSL-1.1-MIT"), "block")
        self.assertEqual(self.verdict("BUSL-1.1"), "block")
        self.assertEqual(self.verdict("PolyForm-Noncommercial-1.0.0"), "block")
        self.assertEqual(self.verdict("EPL-2.0"), "warn")
        self.assertEqual(self.verdict(None), "warn")
        self.assertEqual(self.verdict(""), "warn")
        self.assertEqual(self.verdict("SEE LICENSE IN LICENSE.md"), "warn")
        self.assertEqual(self.verdict("WTFPL"), "warn")  # not on the allow list: review

    def test_exceptions_need_reasons(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump({"exceptions": [{"ecosystem": "npm", "name": "x"}]}, fh)
        with self.assertRaises(SystemExit):
            lc.load_policy(POLICY, fh.name)
        os.unlink(fh.name)


class Scan(unittest.TestCase):
    def test_report_mode_never_fails(self):
        code, by, summary, _ = run("report")
        self.assertEqual(code, 0)
        self.assertIn("## Licence check", summary)

    def test_enforce_mode_fails_on_block(self):
        code, _, _, _ = run("enforce")
        self.assertEqual(code, 1)

    def test_npm_verdicts(self):
        _, by, _, _ = run()
        self.assertEqual(by[("npm", "left-pad")]["verdict"], "allow")
        self.assertEqual(by[("npm", "agpl-thing")]["verdict"], "block")
        self.assertEqual(by[("npm", "gpl-thing")]["verdict"], "warn")
        self.assertEqual(by[("npm", "dual-thing")]["verdict"], "allow")
        self.assertEqual(by[("npm", "and-thing")]["verdict"], "warn")
        self.assertEqual(by[("npm", "vendor-sdk")]["verdict"], "warn")
        self.assertEqual(by[("npm", "no-licence")]["verdict"], "warn")
        self.assertEqual(by[("npm", "caniuse-lite")]["verdict"], "allow")
        self.assertNotIn(("npm", "workspace-link"), by)

    def test_first_party_is_listed_not_judged(self):
        _, by, _, _ = run()
        self.assertEqual(by[("npm", "@rarebit-one/own-agpl")]["verdict"], "first-party")
        self.assertEqual(by[("rubygems", "own_gem")]["verdict"], "first-party")
        self.assertEqual(by[("go", "github.com/rarebit-one/void-which-binds-go")]["verdict"], "first-party")

    def test_recorded_exceptions(self):
        _, by, summary, _ = run()
        self.assertEqual(by[("npm", "sentry")]["verdict"], "allow")
        self.assertIn("LIC-11", by[("npm", "sentry")]["exception"])
        self.assertEqual(by[("rubygems", "brakeman")]["verdict"], "allow")
        self.assertEqual(by[("rubygems", "postmark-rails")]["licence"], "MIT")
        self.assertIn("Allowed by recorded exception", summary)

    def test_rubygems_licence_lists_are_a_choice(self):
        _, by, _, _ = run()
        self.assertEqual(by[("rubygems", "diff-lcs")]["verdict"], "allow")
        self.assertEqual(by[("rubygems", "rdoc")]["verdict"], "allow")
        self.assertEqual(by[("rubygems", "nokogiri")]["version"], "1.18.9")

    def test_go(self):
        _, by, _, _ = run()
        self.assertEqual(by[("go", "github.com/prometheus/client_golang")]["verdict"], "allow")
        self.assertTrue(by[("go", "modernc.org/sqlite")]["indirect"])
        self.assertEqual(by[("go", "github.com/elastic/thing")]["verdict"], "block")

    def test_unsupported_lockfile_is_reported(self):
        _, _, summary, report = run()
        self.assertTrue(any("yarn.lock" in n for n in report["notes"]))
        self.assertIn("Not checked", summary)

    def test_repo_policy_adds_exception(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump({"exceptions": [{"ecosystem": "npm", "name": "gpl-*", "reason": "fixture: build-time only"}]}, fh)
        _, by, _, _ = run(extra_policy=fh.name)
        os.unlink(fh.name)
        self.assertEqual(by[("npm", "gpl-thing")]["verdict"], "allow")
        self.assertEqual(by[("npm", "agpl-thing")]["verdict"], "block")


if __name__ == "__main__":
    unittest.main(verbosity=1)
