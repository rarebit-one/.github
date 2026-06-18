# rarebit-one/.github

Org-level GitHub configuration and reusable workflows for the rarebit-one organization.
## Cognition operating standard

This org's cognition / `-ops` repos follow the cross-org standard (mirrors
sidekick-labs/octo-brain DEC-OCTO-0003 + DEC-OCTO-0004):

- **Sensors/actuators on an issue spine.** Sensors emit GitHub issues for *actionable*
  findings; actuators start from an issue and end in an output (PR / bucket artifact).
  Pure information (digests, reports) → Slack + a Spaces bucket, not a PR.
- **Slack lifecycle.** Scheduled beats narrate one Slack thread (start → progress →
  outcome) via `tools/slack_lifecycle.mjs`; deterministic steps broadcast (the agent
  never holds the token).
- **Channels** (one shared "Sidekick Brains" workspace + bot; named-slot config
  `{danger_room, observability, releases}`, blank slot = fail-soft skip):
  - `#danger-room` — big incidents + playbook-runner
  - `#observability` — Sentry errors + daily/weekly ops reports + ci-health
  - `#releases` — web/mobile releases
  `#ops` is NOT a channel — the `-ops` namespace is reserved for domains. Domain beats
  (finance / delivery / household / library) are unrouted pending their own channels.
- **Scheduling.** Posting beats fire **Mon–Fri** (morning, SGT); **SRE real-time monitors
  (health-sweep, sentry-sweep) fire daily, 7 days**. Non-posting infra is exempt.
- **Review coverage.** Every repo carries `claude-code-review`.
