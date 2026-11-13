#!/usr/bin/env bash
# Pins `dependabot_hold_decision`, the opt-in runtime hold on the Dependabot
# path of .github/workflows/dependabot-auto-merge.yml (`dependabot-hold-runtime`,
# rarebit-one/jumpdrive-runner#248).
#
# Its inputs are the caller's input, fetch-metadata's `package-ecosystem` and
# its `dependency-type`; it prints "hold" or "land". The function is extracted
# verbatim from the workflow between its begin/end markers, so this test cannot
# drift from the YAML.
#
# Run: bash tests/dependabot-hold-runtime.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF="$ROOT/.github/workflows/dependabot-auto-merge.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sed -n '/dependabot_hold_decision: begin/,/dependabot_hold_decision: end/p' "$WF" | sed 's/^          //' > "$TMP/hold.sh"
grep -q "dependabot_hold_decision()" "$TMP/hold.sh" || { echo "FAIL: could not extract dependabot_hold_decision from $WF"; exit 1; }
# shellcheck disable=SC1091
source "$TMP/hold.sh"

pass=0; fail=0
expect() { # expect <hold|land> <label> <hold-runtime> <ecosystem> <dependency-type>
  local want="$1" label="$2" got
  got=$(dependabot_hold_decision "$3" "$4" "$5")
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   - $label ($got)"; else fail=$((fail+1)); echo "FAIL - $label: wanted $want, got $got"; fi
}

# Off (the default): nothing changes for any repo that has not opted in.
expect land "off: npm runtime bump"              false npm_and_yarn direct:production
expect land "off: unknown type"                  false npm_and_yarn unknown
expect land "input empty reads as off"           ""    npm_and_yarn direct:production

# On: npm runtime bumps wait for a human.
expect hold "on: npm direct:production"          true  npm_and_yarn direct:production
expect hold "on: npm unknown type fails closed"  true  npm_and_yarn unknown
expect hold "on: npm empty type fails closed"    true  npm_and_yarn ""
expect land "on: npm direct:development"         true  npm_and_yarn direct:development
expect land "on: npm indirect"                   true  npm_and_yarn indirect

# On: other ecosystems are never held, whatever their type.
expect land "on: github_actions"                 true  github_actions direct:production
expect land "on: docker"                         true  docker unknown
expect land "on: bundler runtime"                true  bundler direct:production

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
