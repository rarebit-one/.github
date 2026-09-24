#!/usr/bin/env bash
# Whole-step harness for the "Review verdict" step in
# .github/workflows/claude-code-review.yml. The step's `run:` is extracted from
# the YAML and executed exactly as Actions does, under `bash -e`. The function
# tests source the functions into a shell WITHOUT -e, which is how a silent red
# once slipped through: under -e, a no-match grep aborted the step with no message.
#
# Run: bash tests/review-verdict-step.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/claude-code-review.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$WF" "$TMP/step.sh" <<'PY'
import sys, yaml
y = yaml.safe_load(open(sys.argv[1]))
steps = [s for j in y["jobs"].values() for s in j.get("steps", []) if s.get("name") == "Review verdict"]
assert len(steps) == 1, "expected exactly one 'Review verdict' step"
open(sys.argv[2], "w").write(steps[0]["run"])
PY

rec() { # rec <file> <subtype> <is_error> <num_turns> <result-text>
  python3 - "$@" <<'PY'
import json, sys
f, sub, err, turns, text = sys.argv[1:6]
recs = [{"type": "system", "subtype": "init"},
        {"type": "result", "subtype": sub, "is_error": err == "true", "num_turns": int(turns),
         "total_cost_usd": 0 if turns == "1" else 0.4, "result": text}]
json.dump(recs, open(f, "w"), indent=1)
PY
}

pass=0; fail=0
run() { # run <want-exit> <want-substring> <label> <O1> <O2> <O3> <EF1>
  local want="$1" sub="$2" label="$3" out rc
  mkdir -p "$TMP/rt"; : > "$TMP/summary"
  out=$(env O1="$4" O2="$5" O3="$6" EF1="$7" EF2= EF3= RUNNER_TEMP="$TMP/rt" GITHUB_STEP_SUMMARY="$TMP/summary" \
        bash -e "$TMP/step.sh" 2>&1); rc=$?
  if [ "$rc" = "$want" ] && grep -qF -- "$sub" <<<"$out"; then pass=$((pass+1)); echo "ok   - $label (exit $rc)"
  else fail=$((fail+1)); echo "FAIL - $label: wanted exit $want + '$sub', got exit $rc"; echo "$out" | tail -3 | sed 's/^/       /'; fi
}

rec "$TMP/clean.json"   success false 9 $'Looks good.\nREVIEW-VERDICT: blocking=0 advisory=2'
rec "$TMP/block.json"   success false 9 $'A bug.\nREVIEW-VERDICT: blocking=2 advisory=1'
rec "$TMP/noline.json"  success false 9 $'A review without the trailer.'
rec "$TMP/quoted.json"  success false 9 $'Quotes REVIEW-VERDICT: blocking=3 advisory=0 but no trailer.'
rec "$TMP/huge.json"    success false 9 $'x\nREVIEW-VERDICT: blocking=99999999999999999999 advisory=0'
rec "$TMP/crash.json"   success true  1 ''
rec "$TMP/failrec.json" error_during_execution true 3 ''
python3 -c 'import json;json.dump([{"type":"system","subtype":"init"},{"type":"result","subtype":"success","is_error":False,"num_turns":9}],open("'"$TMP"'/nores.json","w"))'
rec "$TMP/crlf.json"    success false 9 $'A bug.\r\nREVIEW-VERDICT: blocking=1 advisory=0\r\n\r\n'
rec "$TMP/signoff.json" success false 9 $'A bug.\nREVIEW-VERDICT: blocking=1 advisory=0\n-- reviewer'
rec "$TMP/bold.json"    success false 9 $'A bug.\n**REVIEW-VERDICT: blocking=1 advisory=0**'
printf '[{"type":"system","subtype":"init"}]' > "$TMP/norecord.json"

run 0 "0 blocking findings"      "clean review"                         success skipped skipped "$TMP/clean.json"
run 1 "2 BLOCKING finding"       "blocking findings turn it red"        success skipped skipped "$TMP/block.json"
run 0 "no 'REVIEW-VERDICT"       "no verdict line: green + warning (under bash -e)" success skipped skipped "$TMP/noline.json"
run 0 "no 'REVIEW-VERDICT"       "verdict only quoted mid-text: treated as no line" success skipped skipped "$TMP/quoted.json"
run 1 "BLOCKING finding"         "huge N is still > 0"                  success skipped skipped "$TMP/huge.json"
run 0 "no 'REVIEW-VERDICT"       "result record without .result"        success skipped skipped "$TMP/nores.json"
run 1 "1 BLOCKING finding"       "CRLF endings + trailing CRLF blank line still parse" success skipped skipped "$TMP/crlf.json"
run 0 "no 'REVIEW-VERDICT"       "sign-off after the trailer: not the last line (fails open, warns)" success skipped skipped "$TMP/signoff.json"
run 0 "no 'REVIEW-VERDICT"       "bold-wrapped trailer: not exact (fails open, warns)" success skipped skipped "$TMP/bold.json"
run 1 "NO review ran"            "success with NO execution file (validation skip): fails closed" success skipped skipped ""
run 1 "NO review ran"            "success, file has no result record: fails closed"   success skipped skipped "$TMP/norecord.json"
run 1 "NO review ran"            "success but the record is an error (earlier attempt's): fails closed" failure success skipped "$TMP/failrec.json"
run 0 "known 2026-08-31 upstream bug" "known upstream crash (unchanged)" failure failure failure "$TMP/crash.json"
run 1 "did not succeed"          "real failure (unchanged, fail closed)" failure failure failure "$TMP/failrec.json"

# A retry that SUCCEEDS must stay green. Every attempt writes the same
# $RUNNER_TEMP file, so EF2 points at the successful record: exercise EF2 set,
# EF1 empty (attempt 1 failed before writing an output).
run_ef2() { # run_ef2 <want-exit> <want-substring> <label> <O1> <O2> <O3> <EF2>
  local want="$1" sub="$2" label="$3" out rc
  mkdir -p "$TMP/rt"; : > "$TMP/summary"
  out=$(env O1="$4" O2="$5" O3="$6" EF1= EF2="$7" EF3= RUNNER_TEMP="$TMP/rt" GITHUB_STEP_SUMMARY="$TMP/summary" \
        bash -e "$TMP/step.sh" 2>&1); rc=$?
  if [ "$rc" = "$want" ] && grep -qF -- "$sub" <<<"$out"; then pass=$((pass+1)); echo "ok   - $label (exit $rc)"
  else fail=$((fail+1)); echo "FAIL - $label: wanted exit $want + '$sub', got exit $rc"; echo "$out" | tail -3 | sed 's/^/       /'; fi
}
run_ef2 0 "0 blocking findings"  "retry succeeded (EF2 = real result): stays green" failure success skipped "$TMP/clean.json"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
