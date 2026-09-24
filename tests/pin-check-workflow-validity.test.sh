#!/usr/bin/env bash
# Pins pin-check's fifth check (workflow validity) in .github/workflows/pin-check.yml.
#
# The checker is extracted verbatim from its heredoc in the workflow, so this
# test cannot drift from what actually runs. Each case is a real incident
# shape:
#   - unparseable YAML                 (homelab-ops heyarr-bump.yml, 145 red pushes)
#   - an expression over 21,000 chars  (core-platform-brain standup, silent 09-14 → 09-24)
#   - services:/container: routed to jdb, directly, via vars, or via an input
#     default                          (33 `docker: command not found`)
#
# Run: bash tests/pin-check-workflow-validity.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/pin-check.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sed -n "/<<'WF_VALIDITY_EOF'/,/^ *WF_VALIDITY_EOF$/p" "$WF" | sed '1d;$d' | sed 's/^          //' > "$TMP/wf_validity.py"
grep -q "def runs_on_hits_broker" "$TMP/wf_validity.py" || { echo "FAIL: could not extract the checker from $WF"; exit 1; }
python3 -c 'import yaml' || { echo "FAIL: PyYAML missing"; exit 1; }

pass=0; fail=0
E='$''{{'   # expression opener, assembled so this file never contains it literally
check() { # check <want-exit> <label> <vars-json> <file-or-dir>
  local want="$1" label="$2" vars="$3" target="$4" got out
  out=$(ALL_VARS="$vars" python3 "$TMP/wf_validity.py" "$target" 2>&1); got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   - $label (exit $got)"
  else fail=$((fail+1)); echo "FAIL - $label: wanted exit $want, got $got"; echo "$out" | sed 's/^/       /'; fi
}
case_dir() { local d="$TMP/$1/.github/workflows"; mkdir -p "$d"; cat > "$d/wf.yml"; echo "$TMP/$1"; }

d=$(printf 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          git commit -m "x\n\nbody at column zero"\n' | case_dir bad_yaml)
check 1 "unparseable YAML fails" '{}' "$d"

big=$(python3 -c 'print("x"*21100)')
d=$(printf 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action@abc\n        with:\n          prompt: "%s inputs.dry_run }} %s"\n' "$E" "$big" | case_dir over_limit)
check 1 "expression string over 21,000 chars fails" '{}' "$d"

d=$(printf 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action@abc\n        with:\n          prompt: "%s"\n' "$big" | case_dir literal_long)
check 0 "long literal WITHOUT an expression passes" '{}' "$d"

near=$(python3 -c 'print("x"*19500)')
d=$(printf 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "%s github.sha }} %s"\n' "$E" "$near" | case_dir near_limit)
check 0 "near-limit expression only warns" '{}' "$d"

d=$(printf 'on: pull_request\njobs:\n  a:\n    runs-on: [jdb]\n    services: { pg: { image: postgres } }\n    steps: [{run: echo}]\n' | case_dir svc_literal)
check 1 "services: on literal [jdb] fails" '{}' "$d"

d=$(printf 'on: pull_request\njobs:\n  a:\n    runs-on: %s vars.RUNNER_LABEL || '"'"'ubuntu-latest'"'"' }}\n    container: node:22\n    steps: [{run: echo}]\n' "$E" | case_dir svc_var)
check 1 "container: via vars.RUNNER_LABEL=jdb fails" '{"RUNNER_LABEL":"jdb"}' "$d"
check 0 "same job passes when the var is unset" '{}' "$d"

d=$(printf 'on:\n  workflow_call:\n    inputs:\n      runner-label: { type: string, default: jdb }\njobs:\n  a:\n    runs-on: %s inputs.runner-label }}\n    services: { pg: { image: postgres } }\n    steps: [{run: echo}]\n' "$E" | case_dir svc_input)
check 1 "services: via an input defaulting to jdb fails" '{}' "$d"

d=$(printf 'on:\n  workflow_call:\n    inputs:\n      runner-label: { type: string, default: ubuntu-latest }\njobs:\n  a:\n    runs-on: %s inputs.runner-label }}\n    services: { pg: { image: postgres } }\n    steps: [{run: echo}]\n' "$E" | case_dir svc_input_hosted)
check 0 "services: via an input defaulting to ubuntu-latest passes" '{}' "$d"

d=$(printf 'on: push\njobs:\n  a:\n    runs-on: [jdb-codex-luminality]\n    services: { pg: { image: postgres } }\n    steps: [{run: echo}]\n  b:\n    runs-on: [jdb]\n    steps: [{run: echo}]\n' | case_dir boundaries)
check 0 "jdb-* capability label alone, and jdb without services, pass" '{}' "$d"

mkdir -p "$TMP/fixture/.github/actions/foo/testdata"
printf 'key: "unterminated\n' > "$TMP/fixture/.github/actions/foo/testdata/broken.yml"
printf 'name: foo\nruns: { using: composite, steps: [] }\n' > "$TMP/fixture/.github/actions/foo/action.yml"
check 0 "non-workflow YAML under .github/actions is ignored" '{}' "$TMP/fixture/.github/actions"
printf 'name: foo\nruns: { using: composite\n' > "$TMP/fixture/.github/actions/foo/action.yml"
check 1 "a broken action.yml is still caught" '{}' "$TMP/fixture/.github/actions"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
