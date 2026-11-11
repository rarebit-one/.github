#!/usr/bin/env bash
# Pins the two jq programs behind do-app-deploy's spec write:
#   .github/actions/do-app-deploy/patch-spec.jq  (the intended change)
#   .github/actions/do-app-deploy/spec-drift.jq  (the post-write drift check)
#
# The action runs these exact files (via github.action_path), so this test
# cannot drift from what runs.
#
# Incident it pins: fundbright/delivery-ops#1019. An old doctl silently dropped
# spec fields it did not know (liveness_health_check, maintenance, ...) on a
# get -> edit -> update round trip. The action now writes over REST and fails
# the deploy if the spec DO holds afterwards differs anywhere except the patch.
#
# Run: bash tests/do-app-deploy-spec.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="$ROOT/.github/actions/do-app-deploy"
FIX="$ROOT/tests/fixtures/do-app-deploy/live-spec.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="example-web"
SHA="3333333333333333333333333333333333333333"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

patch() { # patch <names-json> <in> <out>
  jq --argjson names "$1" --arg repo "$REPO" --arg sha "$SHA" -f "$ACTION/patch-spec.jq" "$2" > "$3"
}
drift() { # drift <want> <got>  -> prints differing paths
  # A jq error must never read as "no drift": print a marker that matches no
  # expected output.
  jq -n -r --slurpfile want "$1" --slurpfile got "$2" -f "$ACTION/spec-drift.jq" 2>&1 || echo "JQ_ERROR"
}
expect_drift() { # expect_drift <label> <want> <got> <expected output>
  local got_out
  got_out=$(drift "$2" "$3" 2>&1)
  if [ "$got_out" = "$4" ]; then ok "$1"; else bad "$1" "wanted: [$4] got: [$got_out]"; fi
}

# ── 1. image-only change passes ───────────────────────────────────────────
patch '[]' "$FIX" "$TMP/want.json"
cp "$TMP/want.json" "$TMP/got.json"
expect_drift "image-only change: DO holds exactly the patched spec -> no drift" "$TMP/want.json" "$TMP/got.json" ""

# The patch itself touched only image sources (drift between before and after
# names nothing but the selected components' image/git-source paths).
want_paths=$(drift "$FIX" "$TMP/want.json" | sort)
expected_paths=$(sort <<'EOF'
ADDED workers[0=jobs].image
CHANGED jobs[0=release].image.tag
CHANGED services[0=web].image.tag
CHANGED services[1=agent-service].image.repository
CHANGED services[1=agent-service].image.tag
MISSING jobs[0=release].image.digest
MISSING workers[0=jobs].dockerfile_path
MISSING workers[0=jobs].github
MISSING workers[0=jobs].source_dir
EOF
)
if [ "$want_paths" = "$expected_paths" ]; then ok "patch (all components) changes only image sources"
else bad "patch (all components) changes only image sources" "$want_paths"; fi

# ── 2. a dropped liveness_health_check fails ──────────────────────────────
jq 'del(.services[0].liveness_health_check)' "$TMP/want.json" > "$TMP/got.json"
expect_drift "dropped liveness_health_check is reported" "$TMP/want.json" "$TMP/got.json" \
  "MISSING services[0=web].liveness_health_check"

# ── 3. a dropped top-level maintenance fails ──────────────────────────────
jq 'del(.maintenance)' "$TMP/want.json" > "$TMP/got.json"
expect_drift "dropped top-level maintenance is reported" "$TMP/want.json" "$TMP/got.json" \
  "MISSING maintenance"

# ── 4. the rest of the #1019 field set, all at once ───────────────────────
jq 'del(.disable_email_obfuscation, .ingress.rules[0].match.authority, .services[0].liveness_health_check, .maintenance)' \
  "$TMP/want.json" > "$TMP/got.json"
expect_drift "every field old doctl dropped is reported" "$TMP/want.json" "$TMP/got.json" \
  "MISSING disable_email_obfuscation
MISSING ingress.rules[0].match.authority
MISSING maintenance
MISSING services[0=web].liveness_health_check"

# ── 5. added and changed paths fail; values are never printed ─────────────
jq '.services[0].instance_count = 2 | .envs[1].value = "EV[1:b3RoZXI=:b3RoZXI=]" | .workers[0].autoscaling = {"min_instance_count": 1}' \
  "$TMP/want.json" > "$TMP/got.json"
out=$(drift "$TMP/want.json" "$TMP/got.json")
expect_drift "added and changed paths are reported" "$TMP/want.json" "$TMP/got.json" \
  "ADDED workers[0=jobs].autoscaling
CHANGED envs[1=SECRET_KEY_BASE].value
CHANGED services[0=web].instance_count"
if grep -q 'EV\[' <<<"$out" || grep -q 'staging' <<<"$out"; then bad "drift output never contains values" "$out"
else ok "drift output never contains values"; fi

# ── 6. the one normalisation: an explicit null equals absent ──────────────
jq '.services[0].cpu_kind = null' "$TMP/want.json" > "$TMP/got.json"
expect_drift "null-valued key reads as absent (documented normalisation)" "$TMP/want.json" "$TMP/got.json" ""

# A reordered env list is NOT normalised: DO preserves order (measured).
jq '.envs |= reverse' "$TMP/want.json" > "$TMP/got.json"
if [ -n "$(drift "$TMP/want.json" "$TMP/got.json")" ]; then ok "reordered array is drift (no order normalisation)"
else bad "reordered array is drift (no order normalisation)"; fi

# ── 7. components filter: exact names only ────────────────────────────────
patch '["web","release"]' "$FIX" "$TMP/named.json"
got=$(jq -c '[.services[], .workers[], .jobs[]] | map({(.name): (.image.repository + ":" + (.image.tag // "-"))}) | add' "$TMP/named.json")
want='{"web":"example-web:'"$SHA"'","agent-service":"example-agent:2222222222222222222222222222222222222222","jobs":":-","release":"example-web:'"$SHA"'"}'
if [ "$got" = "$want" ]; then ok "named filter repoints only the named components"
else bad "named filter repoints only the named components" "$got"; fi

patch '["agent"]' "$FIX" "$TMP/substr.json"
if [ -z "$(drift "$FIX" "$TMP/substr.json")" ]; then ok "'agent' does not match 'agent-service' (exact names)"
else bad "'agent' does not match 'agent-service' (exact names)" "$(drift "$FIX" "$TMP/substr.json")"; fi

# Another component's image changing under a filtered promote is drift too.
jq '.services[1].image.tag = "9999999999999999999999999999999999999999"' "$TMP/named.json" > "$TMP/got.json"
expect_drift "unnamed component's image changing is reported" "$TMP/named.json" "$TMP/got.json" \
  "CHANGED services[1=agent-service].image.tag"

# ── 8. absent component arrays stay absent ────────────────────────────────
jq 'del(.workers, .jobs)' "$FIX" > "$TMP/no-workers.json"
patch '[]' "$TMP/no-workers.json" "$TMP/no-workers-patched.json"
if jq -e 'has("workers") or has("jobs") | not' "$TMP/no-workers-patched.json" >/dev/null; then ok "absent workers/jobs are not added to the PUT body"
else bad "absent workers/jobs are not added to the PUT body"; fi

# ── 9. the action actually runs these files ───────────────────────────────
for f in patch-spec.jq spec-drift.jq; do
  if grep -q "github.action_path }}/$f" "$ACTION/action.yml"; then ok "action.yml runs $f"
  else bad "action.yml runs $f"; fi
done

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
