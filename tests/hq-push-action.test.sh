#!/usr/bin/env bash
# Pins the hq-push composite (.github/actions/hq-push/action.yml): it never exits
# non-zero, no-ops without a key, sends the JSON HQ expects, and reports ok/sent
# from HQ's answer. The run script is extracted verbatim from the action, and
# curl is a stub on PATH, so nothing leaves the machine.
#
# Run: bash tests/hq-push-action.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="$ROOT/.github/actions/hq-push/action.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The script is everything indented under `run: |` (8 spaces) to the end of the file.
sed -n '/^      run: |$/,$p' "$ACTION" | tail -n +2 | sed 's/^        //' > "$TMP/run.sh"
grep -q 'hq-push: key not set' "$TMP/run.sh" || { echo "FAIL: could not extract the run script from $ACTION"; exit 1; }

# curl stub: records the headers and the --data payload, answers $STUB_STATUS /
# $STUB_BODY, or fails like a network error when STUB_FAIL=1.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --data) data="$2"; shift ;;
    -H) echo "$2" >> "$STUB_DIR/headers" ;;
  esac
  shift
done
printf '%s' "$data" > "$STUB_DIR/payload"
if [ "${STUB_FAIL:-0}" = 1 ]; then echo "curl: (6) Could not resolve host" >&2; exit 6; fi
printf '%s' "$STUB_BODY" > "$out"
printf '%s' "$STUB_STATUS"
STUB
chmod +x "$TMP/bin/curl"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   - $1"; else fail=$((fail+1)); echo "FAIL - $1: wanted [$3], got [$2]"; fi; }

run() { # inputs come from the caller's environment
  rm -f "$TMP/out" "$TMP/payload" "$TMP/headers"; : > "$TMP/out"
  GITHUB_OUTPUT="$TMP/out" STUB_DIR="$TMP" PATH="$TMP/bin:$PATH" \
    ID="${ID-deploy:example:prod}" TITLE="${TITLE-Deploy failed}" BODY="${BODY-}" URL="${URL-}" SEVERITY="${SEVERITY-fail}" \
    ENDPOINT="https://hq.example.test/api/push" RUN_URL="https://github.com/o/r/actions/runs/1" \
    bash "$TMP/run.sh" > "$TMP/log" 2>&1
  RC=$?
  OK=$(sed -n 's/^ok=//p' "$TMP/out" | tail -1)
  SENT=$(sed -n 's/^sent=//p' "$TMP/out" | tail -1)
}
sent_any() { [ -f "$TMP/payload" ] && echo sent || echo none; }

KEY="" run
check "no key: exit 0" "$RC" 0
check "no key: ok=false" "$OK" false
check "no key: nothing sent" "$(sent_any)" none

export KEY="k.sig" STUB_STATUS=200 STUB_BODY='{"ok":true,"sent":2,"failed":0,"removed":0,"devices":2,"deduped":false}'
run
check "accepted: exit 0" "$RC" 0
check "accepted: ok=true" "$OK" true
check "accepted: sent=2" "$SENT" 2
check "payload: id" "$(jq -r .id "$TMP/payload")" "deploy:example:prod"
check "payload: severity" "$(jq -r .severity "$TMP/payload")" "fail"
check "payload: url defaults to the run" "$(jq -r .url "$TMP/payload")" "https://github.com/o/r/actions/runs/1"
check "bearer header" "$(grep -c '^Authorization: Bearer k.sig$' "$TMP/headers")" 1

URL="/#estate" BODY=$'two\nlines "quoted"' run
check "payload: explicit url" "$(jq -r .url "$TMP/payload")" "/#estate"
check "payload: body survives quoting" "$(jq -r .body "$TMP/payload")" $'two\nlines "quoted"'

STUB_BODY='{"ok":true,"deduped":true,"sent":0}' run
check "deduped: ok=true" "$OK" true
check "deduped: sent=0" "$SENT" 0

STUB_STATUS=409 STUB_BODY='{"ok":false,"error":"push not configured"}' run
check "409: exit 0" "$RC" 0
check "409: ok=false" "$OK" false
check "409: warning names the error" "$(grep -c 'push not configured' "$TMP/log")" 1

STUB_STATUS=401 STUB_BODY='{"error":"push key required"}' run
check "401: exit 0" "$RC" 0
check "401: ok=false" "$OK" false

STUB_STATUS=200 STUB_BODY='{"ok":false,"sent":0,"failed":1}' run
check "200 but nothing delivered: ok=false" "$OK" false

STUB_STATUS=502 STUB_BODY='<html>gateway</html>' run
check "non-JSON 5xx: exit 0" "$RC" 0
check "non-JSON 5xx: ok=false" "$OK" false

STUB_FAIL=1 run
check "network error: exit 0" "$RC" 0
check "network error: ok=false" "$OK" false

ID="" run
check "missing id: exit 0, nothing sent" "$RC/$(sent_any)" "0/none"

echo "--- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
