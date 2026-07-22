#!/usr/bin/env bash
# Dependabot sweep — single-pass, minute-frugal auto-lander across the org.
#
# COMPLEMENTS the per-PR dependabot-auto-merge.yml (which approves minor/patch +
# arms GitHub native auto-merge). Native auto-merge lands a PR the moment it is
# CLEAN, for free — but it never updates a branch, so on strict-protected repos a
# PR that falls BEHIND stalls forever. This sweep mops up that tail:
#
#   Phase 1 (free): MERGE every dependabot PR the per-PR gate already APPROVED
#                   (= confirmed minor/patch) that is CLEAN + MERGEABLE.
#   Phase 2 (adaptive, minute-frugal): for the still-BEHIND approved ones,
#                   rebase exactly ONE per repo per pass. (BEHIND only ever
#                   appears on repos that REQUIRE up-to-date branches; non-strict
#                   repos show CLEAN even when behind, so they land in Phase 1
#                   with zero rebases.) One-per-repo keeps CI cost O(N), not the
#                   O(N^2) thundering-herd you get from rebasing the whole stack.
#
# Majors are never touched: they are not approved by the per-PR gate, so the
# APPROVED filter skips them. DRY_RUN=true logs decisions, changes nothing.
#
# NARRATION: the sweep also writes a Slack-ready digest to $NARRATION_FILE and
# emits counts to $GITHUB_OUTPUT, so the workflow can report what it merged and
# surface the human-gated backlog. Nothing here posts to Slack — that is the
# workflow's job; this script stays runnable locally with no Slack dependency.
set -euo pipefail
ORG="${ORG:?set ORG}"; DRY_RUN="${DRY_RUN:-true}"
# Written by this script, read by the workflow's Slack step. The workflow passes
# an explicit absolute path in env so the two steps can never disagree about it
# (a previously-shipped narrated workflow posted false failures when a producer
# and a consumer step assumed different temp paths).
NARRATION_FILE="${NARRATION_FILE:-./sweep-narration.txt}"
: > "$NARRATION_FILE"

# Age in whole days since an ISO-8601 timestamp.
age_days() { echo $(( ( $(date -u +%s) - $(date -u -d "$1" +%s) ) / 86400 )); }

echo "::group::Dependabot sweep — org=$ORG dry_run=$DRY_RUN"

mapfile -t ROWS < <(gh search prs --owner "$ORG" --author app/dependabot --state open \
  --limit 200 --json repository,number \
  --jq '.[]|"\(.repository.nameWithOwner)\t\(.number)"')
echo "open dependabot PRs: ${#ROWS[@]}"
echo "::endgroup::"

declare -a READY=() BEHIND=() UNARMED=() STUCK=()
for row in "${ROWS[@]+"${ROWS[@]}"}"; do
  repo="${row%%$'\t'*}"; n="${row##*$'\t'}"
  IFS=$'\t' read -r armed state mergeable title created < <(gh pr view "$n" -R "$repo" \
    --json autoMergeRequest,mergeStateStatus,mergeable,title,createdAt \
    --jq '[(if .autoMergeRequest then "armed" else "no" end), .mergeStateStatus, .mergeable, .title, .createdAt]|@tsv')
  age=$(age_days "$created")
  # Gate: act only on PRs the per-PR auto-merge already ARMED (= it confirmed
  # minor/patch + approved). reviewDecision is unreliable here (0 required
  # reviewers leaves it null even after the bot approves), so arming is the
  # durable signal. Majors are never armed -> skipped.
  #
  # NOTE for narration: "not armed" is NOT a synonym for "major". A major bump is
  # the expected reason, but an arming call that failed (the per-PR gate swallows
  # `gh pr merge --auto` errors with `|| echo ::warning::`) lands in this same
  # bucket and looks identical from here. So report it as human-gated WITHOUT
  # asserting it is a major, and lead with age — a genuinely stuck PR shows up as
  # an old one, which is the signal worth acting on.
  if [ "$armed" != "armed" ]; then
    echo "skip $repo#$n -- not armed by per-PR gate (age ${age}d)"
    UNARMED+=("$repo#$n|$age|$title")
    continue
  fi
  if [ "$mergeable" != "MERGEABLE" ]; then
    echo "skip $repo#$n — $mergeable/$state"
    STUCK+=("$repo#$n|$age|$mergeable/$state|$title")
    continue
  fi
  case "$state" in
    CLEAN)  READY+=("$repo#$n|$title") ;;
    BEHIND) BEHIND+=("$repo#$n|$title") ;;
    *)      echo "wait $repo#$n — $state"
            # UNSTABLE is transient: it means a non-required check is red or CI is
            # still running, and an ARMED PR in that state lands by itself the
            # moment checks finish. Surfacing it immediately would put every
            # freshly-opened PR in the "Blocked" list and trigger a digest post
            # for something that needs no attention — so only report it once it
            # has clearly stopped progressing. BLOCKED (failing REQUIRED check or
            # missing review) is reported straight away, because that one never
            # resolves on its own.
            if [ "$state" != "UNSTABLE" ] || [ "$age" -ge 2 ]; then
              STUCK+=("$repo#$n|$age|$state|$title")
            fi ;;
  esac
done

declare -a MERGED=() FAILED=()
echo "::group::Phase 1 — merge ready (${#READY[@]})"
for entry in "${READY[@]+"${READY[@]}"}"; do
  pr="${entry%%|*}"; title="${entry#*|}"
  repo="${pr%#*}"; n="${pr#*#}"
  echo "merge $repo#$n"
  if [ "$DRY_RUN" = "true" ]; then
    MERGED+=("$pr|$title")
  elif gh pr merge "$n" -R "$repo" --squash --delete-branch; then
    MERGED+=("$pr|$title")
  else
    echo "  merge failed for $repo#$n"
    FAILED+=("$pr|$title")
  fi
done
echo "::endgroup::"

declare -a REBASED=()
echo "::group::Phase 2 — rebase ONE behind per repo (${#BEHIND[@]} candidates)"
declare -A DONE=()
for entry in "${BEHIND[@]+"${BEHIND[@]}"}"; do
  pr="${entry%%|*}"; title="${entry#*|}"
  repo="${pr%#*}"; n="${pr#*#}"
  if [ -n "${DONE[$repo]:-}" ]; then echo "defer $repo#$n — already rebased one in $repo this pass"; continue; fi
  echo "rebase $repo#$n (strict+behind)"
  [ "$DRY_RUN" = "true" ] || gh pr comment "$n" -R "$repo" --body "@dependabot rebase" >/dev/null
  REBASED+=("$pr|$title")
  DONE[$repo]=1
done
echo "::endgroup::"
echo "sweep complete (dry_run=$DRY_RUN): ready=${#READY[@]} behind-candidates=${#BEHIND[@]} repos-rebased=${#DONE[@]}"

# ---------------------------------------------------------------------------
# Narration payload. Slack mrkdwn: <url|label> for links, *bold* with single
# asterisks. Written whether or not anything happened — the workflow decides
# whether the pass is worth posting.
# ---------------------------------------------------------------------------
pr_link() {  # repo#n -> <https://github.com/repo/pull/n|repo#n>
  local pr="$1" repo n
  repo="${pr%#*}"; n="${pr#*#}"
  printf '<https://github.com/%s/pull/%s|%s>' "$repo" "$n" "$pr"
}

{
  if [ "${#MERGED[@]}" -gt 0 ]; then
    printf '*Merged (%d):*\n' "${#MERGED[@]}"
    for e in "${MERGED[@]}"; do printf '• %s — %s\n' "$(pr_link "${e%%|*}")" "${e#*|}"; done
  fi
  if [ "${#REBASED[@]}" -gt 0 ]; then
    printf '*Rebased (%d)* — lands next pass once green:\n' "${#REBASED[@]}"
    for e in "${REBASED[@]}"; do printf '• %s — %s\n' "$(pr_link "${e%%|*}")" "${e#*|}"; done
  fi
  if [ "${#FAILED[@]}" -gt 0 ]; then
    printf '*:warning: Merge failed (%d)* — needs a look:\n' "${#FAILED[@]}"
    for e in "${FAILED[@]}"; do printf '• %s — %s\n' "$(pr_link "${e%%|*}")" "${e#*|}"; done
  fi
  if [ "${#UNARMED[@]}" -gt 0 ]; then
    printf '*Awaiting you (%d)* — not auto-armed, so expected to be major bumps; an old one may instead be a gate that failed to arm:\n' "${#UNARMED[@]}"
    # Oldest first — age is the signal separating "parked major" from "stuck".
    printf '%s\n' "${UNARMED[@]}" | awk -F'|' '{print $2"\t"$0}' | sort -rn | cut -f2- \
      | while IFS='|' read -r pr age title; do
          printf '• %s — %sd — %s\n' "$(pr_link "$pr")" "$age" "$title"
        done
  fi
  if [ "${#STUCK[@]}" -gt 0 ]; then
    printf '*Blocked (%d)* — armed but not mergeable (usually a red check):\n' "${#STUCK[@]}"
    for e in "${STUCK[@]}"; do
      pr="${e%%|*}"; rest="${e#*|}"; age="${rest%%|*}"; rest="${rest#*|}"; state="${rest%%|*}"; title="${rest#*|}"
      printf '• %s — %s — %sd — %s\n' "$(pr_link "$pr")" "$state" "$age" "$title"
    done
  fi
} >> "$NARRATION_FILE"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  oldest=0
  for e in "${UNARMED[@]+"${UNARMED[@]}"}"; do
    a="${e#*|}"; a="${a%%|*}"
    [ "$a" -gt "$oldest" ] && oldest="$a"
  done
  {
    echo "merged_count=${#MERGED[@]}"
    echo "rebased_count=${#REBASED[@]}"
    echo "failed_count=${#FAILED[@]}"
    echo "unarmed_count=${#UNARMED[@]}"
    echo "stuck_count=${#STUCK[@]}"
    # Oldest human-gated PR in days — lets the workflow escalate a backlog that
    # is genuinely ageing rather than posting the same list forever.
    echo "oldest_unarmed_days=$oldest"
  } >> "$GITHUB_OUTPUT"
fi
