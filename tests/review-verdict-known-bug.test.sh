#!/usr/bin/env bash
# Pins the `is_known_bug` classifier in .github/workflows/claude-code-review.yml.
#
# The classifier decides whether a failed Claude review is the one tolerated
# upstream CLI crash (subtype "success" + is_error true, one turn, $0, no
# api_error_status) or a real failure that must fail the gate closed. It reads
# the action's execution file, whose shape is an implementation detail of
# claude-code-action — a pretty-printed JSON array today, JSONL in older
# versions — so this test feeds it every shape plus the negatives, extracting
# the function verbatim from the workflow between its begin/end markers so the
# test cannot drift from the YAML.
#
# Run: bash tests/review-verdict-known-bug.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/claude-code-review.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RUNNER_TEMP="$TMP"

# Extract the block, strip the YAML indentation, source it.
sed -n '/is_known_bug: begin/,/is_known_bug: end/p' "$WF" | sed 's/^          //' > "$TMP/classifier.sh"
grep -q "is_known_bug()" "$TMP/classifier.sh" || { echo "FAIL: could not extract is_known_bug from $WF"; exit 1; }
# shellcheck disable=SC1091
source "$TMP/classifier.sh"

pass=0; fail=0
expect() { # expect <known|not> <label> <file>
  local want="$1" label="$2" file="$3" got
  if is_known_bug "$file" >/dev/null 2>&1; then got=known; else got=not; fi
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   - $label ($got)"; else fail=$((fail+1)); echo "FAIL - $label: wanted $want, got $got"; fi
}

crash='{"type":"result","subtype":"success","is_error":true,"duration_ms":341,"duration_api_ms":0,"num_turns":1,"total_cost_usd":0,"usage":{},"modelUsage":{},"permission_denials":[],"session_id":"s","uuid":"u"}'
init='{"type":"system","subtype":"init","model":"claude-sonnet-5"}'
real='{"type":"result","subtype":"success","is_error":false,"num_turns":13,"total_cost_usd":0.49,"result":"Review posted"}'
auth='{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"total_cost_usd":0,"api_error_status":401}'
deep='{"type":"result","subtype":"success","is_error":true,"num_turns":7,"total_cost_usd":0.31}'

printf '[\n%s,\n%s\n]\n' "$init" "$crash" > "$TMP/array.json"
printf '%s\n%s\n' "$init" "$crash" > "$TMP/jsonl.json"
printf '%s\n' "$crash" > "$TMP/single.json"
printf '[\n%s,\n%s\n]\n' "$init" "$real" > "$TMP/real.json"
printf '[\n%s,\n%s\n]\n' "$init" "$auth" > "$TMP/auth.json"
printf '[\n%s,\n%s\n]\n' "$init" "$deep" > "$TMP/deep.json"
printf '[\n%s\n]\n' "$init" > "$TMP/noresult.json"
printf '{not json' > "$TMP/garbage.json"
: > "$TMP/empty.json"
# Two result records: the LAST one decides (a crash after a real review is not the fingerprint).
printf '[\n%s,\n%s,\n%s\n]\n' "$init" "$crash" "$real" > "$TMP/crash-then-real.json"
printf '[\n%s,\n%s,\n%s\n]\n' "$init" "$real" "$crash" > "$TMP/real-then-crash.json"

expect known "array file with the crash fingerprint" "$TMP/array.json"
expect known "JSONL file with the crash fingerprint" "$TMP/jsonl.json"
expect known "single result object" "$TMP/single.json"
expect not   "real successful review" "$TMP/real.json"
expect not   "auth failure with api_error_status" "$TMP/auth.json"
expect not   "is_error deep into a review" "$TMP/deep.json"
expect not   "no result record" "$TMP/noresult.json"
expect not   "garbage file" "$TMP/garbage.json"
expect not   "empty file" "$TMP/empty.json"
expect not   "crash record followed by a real result" "$TMP/crash-then-real.json"
expect known "real result followed by a crash record" "$TMP/real-then-crash.json"

# The diagnostic line must name the fields the fingerprint reads.
out="$(is_known_bug "$TMP/array.json" 2>&1)"
grep -q '"subtype":"success"' <<<"$out" && grep -q '"is_error":true' <<<"$out" && grep -q '"num_turns":1' <<<"$out" \
  && { pass=$((pass+1)); echo "ok   - diagnostic line prints the fingerprint fields"; } \
  || { fail=$((fail+1)); echo "FAIL - diagnostic line missing fingerprint fields: $out"; }

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
