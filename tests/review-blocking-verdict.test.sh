#!/usr/bin/env bash
# Pins the success-path judgement in .github/workflows/claude-code-review.yml:
#   - review_blocking: BLOCKING count from the LAST `REVIEW-VERDICT: blocking=N`
#     line of the final result text (blocking > 0 turns the check red);
#   - has_result: an action "success" with no result record means NO review ran
#     (the workflow-validation skip, rarebit-sre#374).
# Both are extracted verbatim from the workflow (with last_result, which lives
# in the is_known_bug block), so the test cannot drift from the YAML.
#
# Run: bash tests/review-blocking-verdict.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/claude-code-review.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RUNNER_TEMP="$TMP"

{ sed -n '/is_known_bug: begin/,/is_known_bug: end/p' "$WF"; sed -n '/review_blocking: begin/,/review_blocking: end/p' "$WF"; } | sed 's/^          //' > "$TMP/fns.sh"
grep -q "review_blocking()" "$TMP/fns.sh" && grep -q "last_result()" "$TMP/fns.sh" || { echo "FAIL: could not extract functions from $WF"; exit 1; }
# shellcheck disable=SC1091
source "$TMP/fns.sh"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; }
mk() { # mk <file> <result-text>
  python3 - "$1" "$2" <<'PY'
import json, sys
recs = [{"type": "system", "subtype": "init"},
        {"type": "result", "subtype": "success", "is_error": False, "num_turns": 9, "result": sys.argv[2]}]
json.dump(recs, open(sys.argv[1], "w"), indent=1)
PY
}
blocking_is() { # blocking_is <want> <label> <file>
  local got; got="$(review_blocking "$3")"
  [ "$got" = "$1" ] && ok "$2 (blocking='$got')" || bad "$2: wanted '$1', got '$got'"
}

mk "$TMP/clean.json" $'All good.\nREVIEW-VERDICT: blocking=0 advisory=2'
mk "$TMP/block.json" $'A bug.\nREVIEW-VERDICT: blocking=3 advisory=0'
mk "$TMP/noline.json" $'A review without the trailer.'
mk "$TMP/last.json" $'Quoting an old REVIEW-VERDICT: blocking=5 line.\nREVIEW-VERDICT: blocking=0 advisory=1'
printf '%s\n' '{"type":"system","subtype":"init"}' '{"type":"result","subtype":"success","is_error":false,"result":"x\nREVIEW-VERDICT: blocking=1 advisory=0"}' > "$TMP/jsonl.json"
printf '[{"type":"system","subtype":"init"}]' > "$TMP/noresult.json"
printf '{not json' > "$TMP/garbage.json"
: > "$TMP/empty.json"

blocking_is 0  "clean review"                          "$TMP/clean.json"
blocking_is 3  "blocking findings"                     "$TMP/block.json"
blocking_is "" "no REVIEW-VERDICT line"                "$TMP/noline.json"
blocking_is 0  "the LAST verdict line wins"            "$TMP/last.json"
blocking_is 1  "JSONL execution file"                  "$TMP/jsonl.json"
blocking_is "" "no result record"                      "$TMP/noresult.json"

has_result "$TMP/clean.json"    && ok "has_result: real review"        || bad "has_result: real review"
has_result "$TMP/noresult.json" && bad "has_result: no result record"   || ok "has_result: no result record → no review ran"
has_result "$TMP/garbage.json"  && bad "has_result: garbage file"       || ok "has_result: garbage file → no review ran"
has_result "$TMP/empty.json"    && bad "has_result: empty file"         || ok "has_result: empty file → no review ran"
has_result "$TMP/missing.json"  && bad "has_result: missing file"       || ok "has_result: missing file → no review ran"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
