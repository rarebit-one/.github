#!/usr/bin/env bash
# Pins the `token-check` step of .github/workflows/claude-code-review.yml.
#
# A review that did not run must not conclude green on a PR the auto-lander's
# maintainer gate considers (rarebit-sre#317). The step's script is read out of
# the parsed workflow by its step id, so this test cannot drift from the YAML.
#
# Run: bash tests/review-token-check.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/claude-code-review.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$WF" > "$TMP/step.sh" <<'PY' || { echo "FAIL: could not extract the token-check step from $WF"; exit 1; }
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
for job in wf["jobs"].values():
    for step in job.get("steps", []):
        if step.get("id") == "token-check":
            print(step["run"])
            sys.exit(0)
sys.exit(1)
PY

pass=0; fail=0
check() { # check <label> <author> <token> <want-exit> <want-skip> <want-summary: yes|no>
  local label="$1" author="$2" token="$3" want_exit="$4" want_skip="$5" want_sum="$6" got_exit got_skip got_sum
  : > "$TMP/out"; : > "$TMP/sum"
  PR_AUTHOR="$author" CLAUDE_CODE_OAUTH_TOKEN="$token" GITHUB_OUTPUT="$TMP/out" GITHUB_STEP_SUMMARY="$TMP/sum" \
    bash -e "$TMP/step.sh" > /dev/null 2>&1; got_exit=$?
  got_skip=$(sed -n 's/^skip=//p' "$TMP/out")
  if [ -s "$TMP/sum" ]; then got_sum=yes; else got_sum=no; fi
  if [ "$got_exit" = "$want_exit" ] && [ "$got_skip" = "$want_skip" ] && [ "$got_sum" = "$want_sum" ]; then
    pass=$((pass+1)); echo "ok   - $label"
  else
    fail=$((fail+1)); echo "FAIL - $label: wanted exit=$want_exit skip=$want_skip summary=$want_sum, got exit=$got_exit skip=$got_skip summary=$got_sum"
  fi
}

check "maintainer PR, no token: fails closed"        "jaryl"           ""  1 true  yes
check "maintainer PR, token present: runs"           "jaryl"           "x" 0 false no
check "Dependabot PR, no token: green, reason logged" "dependabot[bot]" ""  0 true  yes
check "Dependabot PR, token present: reason logged"   "dependabot[bot]" "x" 0 false yes

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
