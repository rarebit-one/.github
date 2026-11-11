#!/usr/bin/env bash
# Pins .github/scripts/do-spec-edit.sh, the operator path for changing a live
# App Platform spec (GET -> jq -> PUT -> drift check), against a stub curl that
# plays the DO API. No network, no token.
#
# Incident it pins: fundbright/delivery-ops#1019 (a doctl spec round trip
# dropped fields it did not know, and the write deleted them from the app).
#
# Run: bash tests/do-spec-edit.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/.github/scripts/do-spec-edit.sh"
FIX="$ROOT/tests/fixtures/do-app-deploy/live-spec.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP="11111111-2222-3333-4444-555555555555"
NAME="$(jq -r .name "$FIX")"
TOKEN="dop_v1_test_token_that_must_never_reach_argv"
SECRET="plaintext-secret-value-that-must-never-be-printed"

# ── stub curl ─────────────────────────────────────────────────────────────
# Serves $STUB/app.json on GET. On PUT it records the call, applies
# $STUB_MUTATE (a jq filter standing in for DO rewriting the spec), encrypts
# plaintext SECRET values as DO does, stores the result for later GETs and
# answers {"app": {spec, pending_deployment}} unless STUB_PUT_NO_SPEC is set.
# STUB_PUT_CODE forces an error status. Its argv is logged for the token check.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
cat > "$STUB/last-config"   # the -K - config on stdin
printf '%s\n' "$*" >> "$STUB/argv"
method=GET out="" body=""
while (($#)); do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    --data-binary) body="${2#@}"; shift 2 ;;
    -H|-w|--max-time|--retry|-K) shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$method" == GET ]]; then
  cp "$STUB/app.json" "$out"; printf 200; exit 0
fi
touch "$STUB/put-called"
if [[ -n "${STUB_PUT_CODE:-}" ]]; then
  printf '{"id":"unprocessable_entity","message":"stub refused"}' > "$out"; printf '%s' "$STUB_PUT_CODE"; exit 0
fi
jq "${STUB_MUTATE:-.}"' | (.. | objects | select(.type? == "SECRET" and (.value | type) == "string" and (.value | startswith("EV[") | not)) | .value) |= "EV[1:c3R1Yg==:ZW5jcnlwdGVk]"' \
  <(jq .spec "$body") > "$STUB/held.json"
jq -n --slurpfile s "$STUB/held.json" '{app: {spec: $s[0], pending_deployment: {id: "dep-123"}}}' > "$STUB/app.json"
if [[ -n "${STUB_PUT_NO_SPEC:-}" ]]; then
  printf '{"app":{"pending_deployment":{"id":"dep-123"}}}' > "$out"
else
  cp "$STUB/app.json" "$out"
fi
printf 200
STUB
chmod +x "$TMP/bin/curl"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# run <args...>: fresh stub state, runs the script, sets $out and $rc.
run() {
  export STUB="$TMP/stub"
  rm -rf "$STUB" "$TMP/backup"; mkdir -p "$STUB"
  jq -n --slurpfile s "$FIX" '{app: {id: "x", spec: $s[0]}}' > "$STUB/app.json"
  out=$(PATH="$TMP/bin:$PATH" DIGITALOCEAN_ACCESS_TOKEN="$TOKEN" DO_SPEC_EDIT_BACKUP_DIR="$TMP/backup" \
        DO_API_URL="https://api.invalid/v2" bash "$SCRIPT" "$@" 2>&1)
  rc=$?
}
has() { [[ "$out" == *"$1"* ]]; }
held() { jq "$1" "$STUB/held.json"; }

SET_FOO='(.services[0].envs) += [{key: "FOO", value: "bar", scope: "RUN_TIME"}]'

# ── 1. dry run lists the change and writes nothing ────────────────────────
run --name "$NAME" "$APP" "$SET_FOO"
if [[ $rc == 0 ]] && has "ADDED services[0=web].envs[" && has "Dry run" && [[ ! -e "$STUB/put-called" ]]; then
  ok "dry run lists changed paths and does not PUT"
else bad "dry run lists changed paths and does not PUT" "rc=$rc $out"; fi

# ── 2. a wrong --name stops before anything is written ────────────────────
run --name not-this-app --apply "$APP" "$SET_FOO"
if [[ $rc != 0 ]] && has "not 'not-this-app'" && [[ ! -e "$STUB/put-called" ]]; then
  ok "wrong --name refuses without writing"
else bad "wrong --name refuses without writing" "rc=$rc $out"; fi

# ── 3. --apply writes, DO holds exactly the spec -> no drift ──────────────
run --name "$NAME" --apply "$APP" "$SET_FOO"
if [[ $rc == 0 ]] && has "No drift" && has "dep-123" && [[ -e "$STUB/put-called" ]] \
   && [[ "$(held '.services[0].envs[-1].value')" == '"bar"' ]] \
   && [[ "$(held '.services[0].liveness_health_check != null and .maintenance != null')" == true ]]; then
  ok "apply writes the change and keeps every other field"
else bad "apply writes the change and keeps every other field" "rc=$rc $out"; fi
if compgen -G "$TMP/backup/$NAME-*.json" >/dev/null \
   && [[ "$(jq '.app.spec == $s[0]' --slurpfile s "$FIX" "$TMP"/backup/"$NAME"-*.json)" == true ]]; then
  ok "apply keeps the pre-write app JSON as a backup"
else bad "apply keeps the pre-write app JSON as a backup"; fi

# ── 4. DO dropping a field it should have kept -> SPEC DRIFT, exit 1 ──────
STUB_MUTATE='del(.services[0].liveness_health_check)' run --name "$NAME" --apply "$APP" "$SET_FOO"
if [[ $rc == 1 ]] && has "SPEC DRIFT" && has "MISSING services[0=web].liveness_health_check" && has "WAS applied"; then
  ok "a dropped liveness_health_check fails with SPEC DRIFT"
else bad "a dropped liveness_health_check fails with SPEC DRIFT" "rc=$rc $out"; fi

STUB_MUTATE='del(.maintenance)' run --name "$NAME" --apply "$APP" "$SET_FOO"
if [[ $rc == 1 ]] && has "MISSING maintenance"; then ok "a dropped top-level maintenance fails"
else bad "a dropped top-level maintenance fails" "rc=$rc $out"; fi

# ── 5. a plaintext SECRET written via env comes back encrypted: not drift ─
SET_SECRET='(.envs[] | select(.key == "SECRET_KEY_BASE")) |= (.value = env.NEW_SECRET | .type = "SECRET")'
NEW_SECRET="$SECRET" run --name "$NAME" --apply "$APP" "$SET_SECRET"
if [[ $rc == 0 ]] && has "No drift" && has "1 plaintext SECRET value(s) now encrypted"; then
  ok "a plaintext SECRET that DO encrypts is not drift"
else bad "a plaintext SECRET that DO encrypts is not drift" "rc=$rc $out"; fi
if ! has "$SECRET" && ! grep -qF "$SECRET" "$STUB/argv"; then ok "the secret value is never printed or put on argv"
else bad "the secret value is never printed or put on argv"; fi

# ...but a SECRET whose key DO changed at that path still is drift.
NEW_SECRET="$SECRET" STUB_MUTATE='(.envs[] | select(.key == "SECRET_KEY_BASE") | .key) = "RENAMED"' \
  run --name "$NAME" --apply "$APP" "$SET_SECRET"
if [[ $rc == 1 ]] && has "SPEC DRIFT" && ! has "$SECRET"; then
  ok "a SECRET env whose key changed is still drift"
else bad "a SECRET env whose key changed is still drift" "rc=$rc $out"; fi

# ...and an untouched EV[...] value that DO re-encrypted is drift too.
STUB_MUTATE='(.envs[] | select(.key == "SECRET_KEY_BASE") | .value) = "EV[1:b3RoZXI=:b3RoZXI=]"' \
  run --name "$NAME" --apply "$APP" "$SET_FOO"
if [[ $rc == 1 ]] && has "CHANGED envs[1=SECRET_KEY_BASE].value" ; then
  ok "an unchanged EV[...] secret that comes back different is drift"
else bad "an unchanged EV[...] secret that comes back different is drift" "rc=$rc $out"; fi

# ── 6. a PUT response without .app.spec is checked against a fresh GET ────
STUB_PUT_NO_SPEC=1 run --name "$NAME" --apply "$APP" "$SET_FOO"
if [[ $rc == 0 ]] && has "No drift"; then ok "no spec in the PUT response: read back with GET"
else bad "no spec in the PUT response: read back with GET" "rc=$rc $out"; fi

# ── 6b. setting image.registry on a DOCR image is a requested change ──────
# spec-drift.jq forgives DO ADDING a registry after a write; the change listing
# must not, or an operator's registry edit reads as "No change" and is dropped.
DOCR_FIX="$TMP/docr-spec.json"
jq '.services[0].image = {registry_type: "DOCR", repository: "web", tag: "abc"}' "$FIX" > "$DOCR_FIX"
FIX_SAVED="$FIX"; FIX="$DOCR_FIX"
run --name "$NAME" --apply "$APP" '.services[0].image.registry = "acme"'
FIX="$FIX_SAVED"
if [[ $rc == 0 ]] && has "ADDED services[0=web].image.registry" && [[ -e "$STUB/put-called" ]] \
   && [[ "$(held '.services[0].image.registry')" == '"acme"' ]] && has "No drift"; then
  ok "adding image.registry is listed and written, not read as no change"
else bad "adding image.registry is listed and written, not read as no change" "rc=$rc $out"; fi

# ── 7. a filter that changes nothing writes nothing ───────────────────────
run --name "$NAME" --apply "$APP" '.'
if [[ $rc == 0 ]] && has "No change" && [[ ! -e "$STUB/put-called" ]]; then
  ok "a no-op filter does not PUT"
else bad "a no-op filter does not PUT" "rc=$rc $out"; fi

# ── 8. DO refusing the PUT fails with its message ─────────────────────────
STUB_PUT_CODE=422 run --name "$NAME" --apply "$APP" "$SET_FOO"
if [[ $rc != 0 ]] && has "HTTP 422" && has "stub refused"; then ok "a refused PUT fails with DO's message"
else bad "a refused PUT fails with DO's message" "rc=$rc $out"; fi

# ── 9. guards ─────────────────────────────────────────────────────────────
run --name "$NAME" --apply "$APP" '.services'
if [[ $rc != 0 ]] && has "exactly one spec object" && [[ ! -e "$STUB/put-called" ]]; then
  ok "a filter that does not output a spec object is refused"
else bad "a filter that does not output a spec object is refused" "rc=$rc $out"; fi

out=$(env -u DIGITALOCEAN_ACCESS_TOKEN bash "$SCRIPT" --name "$NAME" "$APP" '.' 2>&1); rc=$?
if [[ $rc != 0 ]] && has "DIGITALOCEAN_ACCESS_TOKEN"; then ok "refuses without a token"
else bad "refuses without a token" "rc=$rc $out"; fi

run --name "$NAME" --apply "$APP" "$SET_FOO"
if ! grep -qF "$TOKEN" "$STUB/argv" && grep -qF "$TOKEN" "$STUB/last-config"; then
  ok "the token reaches curl on stdin, never argv"
else bad "the token reaches curl on stdin, never argv"; fi

echo
echo "do-spec-edit: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
