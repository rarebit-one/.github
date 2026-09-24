#!/usr/bin/env bash
# Pins `classify_review_runs`, the maintainer-path review gate in
# .github/workflows/dependabot-auto-merge.yml.
#
# The gate decides whether a maintainer PR's code review has concluded cleanly
# enough to arm auto-merge. Its input is one "<status>\t<conclusion>\t<name>"
# line per matching check run on the PR head. The function is extracted
# verbatim from the workflow between its begin/end markers, so this test cannot
# drift from the YAML.
#
# Incidents it pins:
#   - rarebit-sre#330: a `skipped` draft-phase run read as clean.
#   - the GNU-grep `\t` bug: a failure that could never match.
#
# Run: bash tests/maintainer-review-gate.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/dependabot-auto-merge.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sed -n '/classify_review_runs: begin/,/classify_review_runs: end/p' "$WF" | sed 's/^          //' > "$TMP/gate.sh"
grep -q "classify_review_runs()" "$TMP/gate.sh" || { echo "FAIL: could not extract classify_review_runs from $WF"; exit 1; }
# shellcheck disable=SC1091
source "$TMP/gate.sh"

pass=0; fail=0
T=$'\t'
N="review / Claude Code Review"
expect() { # expect <wait|clean|failed> <label> <input>
  local want="$1" label="$2" input="$3" got
  got=$(printf '%s\n' "$input" | classify_review_runs)
  got=${got%%$'\t'*}
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   - $label ($got)"; else fail=$((fail+1)); echo "FAIL - $label: wanted $want, got $got"; fi
}

expect wait   "no runs at all"                         ""
expect wait   "only a skipped run (rarebit-sre#330)"    "completed${T}skipped${T}$N"
expect wait   "only neutral + stale runs"               "completed${T}neutral${T}$N
completed${T}stale${T}$N"
expect wait   "skipped plus one still in progress"      "completed${T}skipped${T}$N
in_progress${T}-${T}$N"
expect clean  "skipped then a real success"             "completed${T}skipped${T}$N
completed${T}success${T}$N"
expect clean  "single success"                          "completed${T}success${T}$N"
expect failed "single failure"                          "completed${T}failure${T}$N"
expect failed "timed_out is a failure"                  "completed${T}timed_out${T}$N"
expect failed "cancelled is a failure"                  "completed${T}cancelled${T}$N"
expect failed "action_required is a failure"            "completed${T}action_required${T}$N"
expect failed "success plus a failed re-run"            "completed${T}success${T}$N
completed${T}failure${T}$N"
expect wait   "failure but another run still queued"    "completed${T}failure${T}$N
queued${T}-${T}$N"

# The reported line must be the one that DROVE the verdict, not the first line.
out=$(printf '%s\n' "completed${T}success${T}a / $N" "completed${T}failure${T}b / $N" | classify_review_runs)
[ "${out#*$'\t'}" = "completed${T}failure${T}b / $N" ] \
  && { pass=$((pass+1)); echo "ok   - failed verdict reports the failing run"; } \
  || { fail=$((fail+1)); echo "FAIL - failed verdict reported: ${out#*$'\t'}"; }
out=$(printf '%s\n' "completed${T}skipped${T}a / $N" "completed${T}success${T}b / $N" | classify_review_runs)
[ "${out#*$'\t'}" = "completed${T}success${T}b / $N" ] \
  && { pass=$((pass+1)); echo "ok   - clean verdict never reports a skipped run"; } \
  || { fail=$((fail+1)); echo "FAIL - clean verdict reported: ${out#*$'\t'}"; }

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
