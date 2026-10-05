## Linked issue

Closes #<!-- issue number (required) -->

## What

<!-- What does this PR change? Link the delivery-plan task (e.g. M0 0.2). -->

## Why

<!-- The problem it solves or the decision it implements. -->

## How to test

<!-- Commands or steps a reviewer can run. -->

## Checklist

- [ ] `pnpm nx affected -t lint test build typecheck validate` passes
- [ ] No secrets committed (passwords/keys live in GCP Secret Manager only)
- [ ] GDPR: any new personal or Article 9 data is covered by consent and the erasure/retention map
- [ ] Docs updated (README / runbooks) if behaviour or setup changed
