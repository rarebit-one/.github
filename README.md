# rarebit-one/.github

Org-level GitHub configuration and reusable workflows for the rarebit-one organization.
## Cognition operating standard

This org's cognition / `-ops` repos follow the cross-org standard (mirrors
sidekick-labs/octo-brain DEC-OCTO-0003 + DEC-OCTO-0004):

- **Sensors/actuators on an issue spine.** Sensors emit GitHub issues for *actionable*
  findings; actuators start from an issue and end in an output (PR / bucket artifact).
  Pure information (digests, reports) → the run summary, a Spaces bucket or the HQ
  feeds, not a PR and not Slack.
- **Slack is for interrupts.** Routine beat narration (start → progress → outcome
  threads, weekly digests) was retired on 2026-11-26; the HQ dashboard carries that
  picture. What still posts: incidents, and the release threads of the shared
  reusable workflows other orgs call. Deterministic steps post; the agent never holds
  the token.
- **Channels** (one shared "Sidekick Brains" workspace + bot; named-slot config,
  blank slot = fail-soft skip):
  - `#danger-room` — big incidents + playbook-runner
  - `#releases` — web/mobile releases
  `#ops` is NOT a channel — the `-ops` namespace is reserved for domains. Domain beats
  (finance / delivery / household / library) are unrouted pending their own channels.
- **Scheduling.** Posting beats fire **Mon–Fri** (morning, SGT); **SRE real-time monitors
  (health-sweep, sentry-sweep) fire daily, 7 days**. Non-posting infra is exempt.
- **Review coverage.** Every repo carries `claude-code-review`.

## Licence

Copyright (c) 2026 Rarebit One. Licensed under the [MIT License](LICENSE). That covers the reusable workflows, composite actions and scripts here, which other repositories and organisations call.
