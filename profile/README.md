# rarebit-one

Production Rails apps and the Ruby gems that support them.

## Apps

- **luminality-web** — AI-powered mindfulness journeys (Rails 8 + React 19 via Inertia)
- **nutripod-web** — vending-machine ops e-commerce (Rails 8 + React 19 via Inertia)
- **fundbright-web** — lending platform (Rails 8 + React 19 via Inertia)

## Shared gems

- **standard_id** — authentication engine (OAuth 2.0, OIDC, passwordless, social login)
- **standard_id-apple / standard_id-google** — social-auth provider plugins
- **standard_audit** — database audit logging for model and auth events
- **standard_circuit** — circuit-breaker primitives shared across services

## Conventions

All workflows used across the org live in [`.github/workflows/`](../.github/workflows). Ruby gems consume the shared `reusable-gem-ci.yml` / `reusable-gem-release.yml`; web apps consume the shared `reusable-weekly-maintenance.yml`. See [`docs/reusable-workflows.md`](../docs/reusable-workflows.md) for the full input contract.

## Security

See [SECURITY.md](../SECURITY.md) for the vulnerability-disclosure policy.
