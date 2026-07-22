#!/usr/bin/env bash
# Decide whether ONE checked-out gem repo has work worth releasing.
#
# CI port of the workspace's canonical `.claude/scripts/check-gem-release-drift.sh`
# (see rarebit-one's .claude/conventions/gem-releases-and-ownership.md). Same
# method, same verdicts; this variant operates on a single repo already checked
# out by the workflow and emits machine-readable outputs instead of a table.
#
# WHY THIS METHOD, and not commit inspection: a gem is up to date when its
# PACKAGED SURFACE is unchanged since its last tag — not when `git log tag..HEAD`
# is empty. These repos carry large backlogs of CI hardening, Dependabot bumps
# and agent-tooling housekeeping, none of which ships inside the .gem
# (standard_health: 46 commits, zero of them publishable). Counting commits, or
# even reading commit subjects, reports permanent false drift. Building the
# actual .gem at both refs and diffing the payload is exact: it honours each
# gemspec's own selection rules (the family mixes `git ls-files` reject-lists
# with `Dir[]` include-globs) and catches deletions and renames.
#
# Verdicts:
#   OK        packaged surface identical           -> no release
#   PACKAGING artifact differs, no lib/app/config  -> rides along with the next
#                                                     real release; never justifies one
#   BEHAVIOUR consumers would receive new code     -> release it
#
# Outputs (to $GITHUB_OUTPUT when set): verdict, current, next, bump, delta.
set -uo pipefail

REPO_DIR="${REPO_DIR:-.}"
cd "$REPO_DIR"

emit() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT"; }
log() { echo "$*" >&2; }

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

# Build the gem at $1=git_ref and extract its payload into $2=destdir.
# A detached worktree is required, not a plain `git archive`: gemspecs that
# shell out to `git ls-files` only work inside a real work tree.
build_payload() {
  local ref="$1" dest="$2"
  local wt="$TMPROOT/wt-$RANDOM"
  git worktree add --detach "$wt" "$ref" >/dev/null 2>&1 || { log "  ! worktree failed at $ref"; return 1; }
  local gemfile rc=1
  gemfile=$(cd "$wt" && gem build ./*.gemspec 2>/dev/null | awk '/File:/ {print $2}')
  if [ -n "$gemfile" ] && [ -f "$wt/$gemfile" ]; then
    mkdir -p "$dest"
    ( cd "$dest" && tar xf "$wt/$gemfile" && tar xzf data.tar.gz \
      && rm -f data.tar.gz metadata.gz checksums.yaml.gz ) && rc=0
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1
  return $rc
}

tag=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [ -z "$tag" ]; then
  # A gem with no tags has never been released; the first release is a
  # deliberate human act, not something to prep automatically.
  log "no tags — skipping"; emit "verdict=OK"; exit 0
fi

commits=$(git rev-list --count "$tag..HEAD" 2>/dev/null || echo 0)
if [ "$commits" = "0" ]; then
  log "OK — $tag == HEAD"; emit "verdict=OK"; exit 0
fi

if ! build_payload "$tag" "$TMPROOT/old" || ! build_payload HEAD "$TMPROOT/new"; then
  log "ERROR — could not build at $tag and/or HEAD"; emit "verdict=ERROR"; exit 0
fi

delta=$(diff -rq "$TMPROOT/old" "$TMPROOT/new" 2>&1 | sed "s|$TMPROOT/||g")

if [ -z "$delta" ]; then
  log "OK — $commits commit(s) since $tag, packaged surface identical"
  emit "verdict=OK"; exit 0
fi

if ! grep -qE '(^|/)(lib|app|config)/' <<<"$delta"; then
  log "PACKAGING — $commits commit(s) since $tag, artifact differs but no code change:"
  log "$delta"
  emit "verdict=PACKAGING"
  { echo 'delta<<EOF'; echo "$delta"; echo EOF; } >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# --- BEHAVIOUR: consumers would receive new code ----------------------------
log "BEHAVIOUR — $commits commit(s) since $tag, consumers would receive new code:"
log "$delta"

cur="${tag#v}"
IFS='.' read -r MA MI PA <<<"$cur"

# Bump size. Prefer the CHANGELOG's own headings when it has an [Unreleased]
# section: these repos do not use conventional commits consistently — the real
# standard_singpass 0.2.0 release was titled "Retry the userinfo fetch on a
# transient upstream 5xx" with no prefix — so sizing off commit prefixes alone
# would have called that release a patch. Keep-a-Changelog semantics:
# Added/Changed/Removed alter the surface (minor); Fixed/Security (patch).
unreleased=$(awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md 2>/dev/null | grep -vE '^\s*$' || true)
case "$(tr -d '[:space:]' <<<"$unreleased" | tr '[:upper:]' '[:lower:]')" in
  ''|'nothingyet.'|'none.'|'n/a') unreleased='' ;;
esac
subjects=$(git log --format='%s' "$tag..HEAD")
bodies=$(git log --format='%B' "$tag..HEAD")

if grep -qE '^[a-z]+(\(.+\))?!:' <<<"$subjects" || grep -q 'BREAKING CHANGE' <<<"$bodies"; then
  # Pre-1.0 (all of these gems), SemVer puts a breaking change in the MINOR
  # slot. Consumers pin with `~>`, so a wrong bump strands or breaks them.
  if [ "$MA" -eq 0 ]; then bump=minor; else bump=major; fi
elif [ -n "$unreleased" ]; then
  if grep -qiE '^###[[:space:]]+(Added|Changed|Removed)' <<<"$unreleased"; then bump=minor; else bump=patch; fi
elif grep -qiE '^feat(\(.+\))?:' <<<"$subjects"; then
  bump=minor
else
  bump=patch
fi

case "$bump" in
  major) next="$((MA+1)).0.0" ;;
  minor) next="$MA.$((MI+1)).0" ;;
  patch) next="$MA.$MI.$((PA+1))" ;;
esac

log "→ propose $cur → $next ($bump)"
emit "verdict=BEHAVIOUR"
emit "current=$cur"
emit "next=$next"
emit "bump=$bump"
{ echo 'delta<<EOF'; echo "$delta"; echo EOF; } >> "${GITHUB_OUTPUT:-/dev/null}"
