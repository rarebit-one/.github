#!/usr/bin/env bash
# do-spec-edit.sh: change a LIVE DigitalOcean App Platform spec without a
# client's spec model in the loop.
#
#   GET /v2/apps/{id} -> jq filter on the raw .app.spec -> PUT {"spec": ...}
#   -> re-read, and fail if DO holds anything other than exactly that spec.
#
# Usage (dry run is the default; nothing is written without --apply):
#   export DIGITALOCEAN_ACCESS_TOKEN=...      # from the vault; never on argv
#   do-spec-edit.sh --name <spec .name> <app-id> '<jq filter>'
#   do-spec-edit.sh --name <spec .name> <app-id> -f change.jq
#   do-spec-edit.sh --name <spec .name> --apply <app-id> '<jq filter>'
#
# The filter receives the live spec exactly as the API returned it and must
# output the whole new spec, e.g.
#   '(.services[] | select(.name == "web") | .envs[] | select(.key == "FOO") | .value) = "bar"'
# Pass a SECRET value through the environment, never in the filter text (argv
# is world-readable via ps):
#   NEW_KEY=... do-spec-edit.sh ... '(.envs[] | select(.key == "API_KEY")) |= (.value = env.NEW_KEY | .type = "SECRET")'
#
# Why (fundbright/delivery-ops#1019): `doctl apps spec get` -> edit ->
# `doctl apps update --spec` sends the spec through doctl's model, and a doctl
# that does not know a field (liveness_health_check, maintenance, ...) drops it;
# the update then deletes it from the live app. Here the spec stays raw API JSON
# end to end, and after the write the spec DO holds is compared, path by path,
# with the spec we PUT (../actions/do-app-deploy/spec-drift.jq, the same check
# the do-app-deploy action runs). Any difference fails loudly with SPEC DRIFT.
#
# One extra normalisation, specific to edits: an env of type SECRET written
# with a plaintext value comes back as EV[...] ciphertext. That is DO doing its
# job, so for exactly those paths "plaintext in, EV[...] out" is not drift.
# Every other path, including every EV[...] value we did not change, must come
# back byte-identical.
#
# Never prints a spec value: specs carry env values, and SECRET ones as
# EV[...]. Changes and drift are reported as paths. Before --apply writes, the
# GET response is kept (mode 600) under $DO_SPEC_EDIT_BACKUP_DIR (default
# ~/.local/state/do-spec-edit) so a bad write can be restored from it.
#
# Needs bash, curl and jq 1.6+. DO_API_URL overrides the API base (tests).
# Pinned by tests/do-spec-edit.test.sh.

set -euo pipefail

DRIFT_JQ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../actions/do-app-deploy" && pwd)/spec-drift.jq"
API="${DO_API_URL:-https://api.digitalocean.com/v2}"
BACKUP_DIR="${DO_SPEC_EDIT_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/do-spec-edit}"

die() { printf 'do-spec-edit: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '9,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

NAME="" APPLY=0 FILTER="" FILTER_FILE="" APP_ID=""
while (($#)); do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -f) FILTER_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    -*) die "unknown option $1" ;;
    *)
      if [[ -z "$APP_ID" ]]; then APP_ID="$1"
      elif [[ -z "$FILTER" && -z "$FILTER_FILE" ]]; then FILTER="$1"
      else die "unexpected argument"
      fi
      shift ;;
  esac
done
[[ -n "$APP_ID" ]] || usage
[[ -n "$NAME" ]] || die "--name <spec name> is required: it is checked against the live app before anything else, so a wrong app id stops here"
[[ -n "$FILTER" || -n "$FILTER_FILE" ]] || die "give a jq filter, inline or with -f <file>"
[[ -z "$FILTER_FILE" || -r "$FILTER_FILE" ]] || die "cannot read filter file $FILTER_FILE"
[[ -n "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]] || die "set DIGITALOCEAN_ACCESS_TOKEN (a token with app read, and update for --apply) in the environment"
command -v jq >/dev/null || die "jq not on PATH"
command -v curl >/dev/null || die "curl not on PATH"
[[ -r "$DRIFT_JQ" ]] || die "missing $DRIFT_JQ (run this from a checkout of rarebit-one/.github)"

umask 077
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

# do_api METHOD PATH OUTFILE [BODYFILE] -> prints the HTTP code ("000" if curl
# itself failed). The token reaches curl on stdin (-K -), never argv. GET
# retries; the PUT never does, since a blind retry could apply a write twice.
do_api() {
  local extra=()
  if [[ -n "${4:-}" ]]; then extra=(-H 'Content-Type: application/json' --data-binary "@$4"); fi
  if [[ "$1" == GET ]]; then extra+=(--retry 3); fi
  printf 'header = "Authorization: Bearer %s"\n' "$DIGITALOCEAN_ACCESS_TOKEN" \
    | curl -sS -K - -X "$1" --max-time 120 "${extra[@]}" -o "$3" -w '%{http_code}' "$API$2" || true
}
api_msg() { jq -r '.message // empty' "$1" 2>/dev/null || true; }
# drift WANT GOT -> "<KIND> <path>" lines. A jq failure must never read as
# "no drift", so it exits non-zero and the caller stops.
drift() { jq -n -r --slurpfile want "$1" --slurpfile got "$2" -f "$DRIFT_JQ"; }
# requested FROM TO -> the paths an edit changes. Exact: the image.registry
# rule is for what DO returns after a write, and here an added registry is a
# change the operator asked for (rarebit-one/.github#185 review).
requested() { jq -n -r --argjson exact true --slurpfile want "$1" --slurpfile got "$2" -f "$DRIFT_JQ"; }

# 1. Read the live app, raw.
code=$(do_api GET "/apps/$APP_ID" "$W/before.json")
[[ "$code" == 200 ]] || die "GET /v2/apps/$APP_ID failed (HTTP $code): $(api_msg "$W/before.json")"
jq -e '.app.spec | type == "object"' "$W/before.json" >/dev/null 2>&1 || die "GET response has no .app.spec"
jq '.app.spec' "$W/before.json" > "$W/live.json"
live_name=$(jq -r '.name' "$W/live.json")
[[ "$live_name" == "$NAME" ]] || die "app $APP_ID is '$live_name', not '$NAME'. Nothing written."

# 2. Apply the filter to the raw spec.
if [[ -n "$FILTER_FILE" ]]; then
  jq -f "$FILTER_FILE" "$W/live.json" > "$W/want.json" || die "the jq filter failed; nothing written"
else
  jq "$FILTER" "$W/live.json" > "$W/want.json" || die "the jq filter failed; nothing written"
fi
[[ "$(jq -s 'length == 1 and (.[0] | type == "object")' "$W/want.json")" == true ]] \
  || die "the filter must output exactly one spec object; nothing written"

# 3. Show the change, as paths.
changes=$(requested "$W/live.json" "$W/want.json") || die "could not compare the specs; nothing written"
if [[ -z "$changes" ]]; then
  echo "No change: the filter leaves the live spec of $NAME as it is. Nothing to write."
  exit 0
fi
echo "Change to $NAME ($APP_ID), as paths (values not shown):"
printf '  %s\n' "$changes"
if ((APPLY == 0)); then
  echo "Dry run: nothing written. Re-run with --apply to write it."
  exit 0
fi

# 4. Keep the pre-write state, then write.
mkdir -p "$BACKUP_DIR"
backup="$BACKUP_DIR/$NAME-$(date -u +%Y%m%dT%H%M%SZ).json"
cp "$W/before.json" "$backup"
echo "Pre-write app JSON kept at $backup"

jq -n --slurpfile s "$W/want.json" '{spec: $s[0]}' > "$W/body.json"
code=$(do_api PUT "/apps/$APP_ID" "$W/update.json" "$W/body.json")
[[ "$code" == 2?? ]] || die "PUT /v2/apps/$APP_ID failed (HTTP $code): $(api_msg "$W/update.json")"
dep=$(jq -r '.app.pending_deployment.id // .app.in_progress_deployment.id // empty' "$W/update.json" 2>/dev/null || true)

# 5. Read what DO now holds: the PUT response, or a fresh GET if it has none.
held="$W/update.json"
if ! jq -e '.app.spec | type == "object"' "$held" >/dev/null 2>&1; then
  held="$W/after.json"
  code=$(do_api GET "/apps/$APP_ID" "$held")
  [[ "$code" == 200 ]] || die "the write WAS applied, but reading it back failed (HTTP $code). Check the app before doing anything else; the pre-write state is $backup"
fi

# 6. Drift check. Plaintext SECRET values we wrote come back encrypted: blank
# exactly those paths on both sides (and only where DO returned EV[...] for the
# same key), then require everything else to match.
# shellcheck disable=SC2016 # jq program text
jq -n --slurpfile want "$W/want.json" --slurpfile got "$held" '
  def plain_secret: type == "object" and .type == "SECRET"
    and (.value | type) == "string" and (.value | startswith("EV[") | not);
  $want[0] as $W
  | ($got[0] | if (.app | type) == "object" then .app.spec else . end) as $G
  | [ $W | paths(plain_secret) as $p
      | select(($G | try getpath($p) catch null) as $g
               | ($g | type) == "object" and $g.key == ($W | getpath($p)).key
               and ($g.value | type) == "string" and ($g.value | startswith("EV["))) | $p ] as $enc
  | def blank: reduce $enc[] as $p (.; setpath($p + ["value"]; "(plaintext written; DO encrypted it)"));
  {want: ($W | blank), got: ($G | blank), encrypted: ($enc | length)}
' > "$W/cmp.json" || die "the write WAS applied, but the drift check could not run. Check the app; the pre-write state is $backup"
jq '.want' "$W/cmp.json" > "$W/want-cmp.json"
jq '.got' "$W/cmp.json" > "$W/got-cmp.json"
encrypted=$(jq '.encrypted' "$W/cmp.json")

if ! out=$(drift "$W/want-cmp.json" "$W/got-cmp.json"); then
  die "the write WAS applied, but the drift check failed to run. Check the app; the pre-write state is $backup"
fi
if [[ -n "$out" ]]; then
  echo "SPEC DRIFT on $NAME ($APP_ID): DO holds a spec that differs from the one written:" >&2
  printf '  %s\n' "$out" >&2
  echo "The write WAS applied${dep:+ and deployment $dep is rolling out}. Restore the listed settings from $backup (its .app.spec) with this script, then investigate." >&2
  exit 1
fi
note=""
if ((encrypted > 0)); then note=" ($encrypted plaintext SECRET value(s) now encrypted by DO)"; fi
echo "No drift: DO holds exactly the spec that was written$note."
if [[ -n "$dep" ]]; then
  echo "Deployment $dep started. Watch it: doctl apps get-deployment $APP_ID $dep"
else
  echo "DO returned no deployment id; check the app's Activity tab."
fi
