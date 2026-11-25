# Testing

Who: everyone who writes or changes tests. Data: none.
Next id: REQ-TST-013

## What a test checks

- **REQ-TST-001** A test checks the system's behaviour; a bad test costs more than a failure that a behaviour test catches and we then fix. [J-2026-10-24-TST]
- **REQ-TST-002** A behaviour is tested at the highest level that can see it: Playwright in `apps/web/e2e`, then the dev behavioural suite (`apps/dev-seed/behavioural`), then integration tests against a real SurrealDB where the database is the behaviour. [J-2026-10-24-TST]
  Example: permissions, consent and publishing are integration tests against a real SurrealDB.
- **REQ-TST-003** A unit test is written only when something is hard to test from above or its logic is complex enough to need its own coverage. [J-2026-10-24-TST]
- **REQ-TST-004** An API route that no finished frontend feature uses yet gets no test. [J-2026-10-24-TST]
- **REQ-TST-005** A test gives the same result locally and in CI: it never depends on timing, machine load, ports or shared state. [J-2026-10-24-TST]
- **REQ-TST-006** A flaky test, or one that stubs away the behaviour it claims to check, is removed or rebuilt at the right level. [J-2026-10-24-TST]
- **REQ-TST-007** When a flaky test has no clear cause or fix, it is rewritten one level lower, and if still unreliable it is proposed for deletion, which the founder approves. [J-2026-11-05-TST]
  Example: an e2e test becomes a component test of the same behaviour.
- **REQ-TST-008** Test-first work happens at the behaviour level, at the point where that behaviour is defined. [J-2026-10-24-TST]

## Browser tests

- **REQ-TST-009** Each new page is covered in `apps/web/e2e`: its "fits the screen" checks run on every device in `devices.ts`, and whole flows and other behaviour run on `BEHAVIOUR_DEVICES` (one phone, one desktop) only. [J-2026-11-05-TST]

## Performance and scale tests

- **REQ-TST-010** Performance and scale tests run only on a developer's machine against a throwaway local SurrealDB in Docker, never in CI and never against Google Cloud or Bunny. [J-2026-11-06-TST]
  Why: the cloud budget.
- **REQ-TST-011** Scale tests live under `scale/*.scale-spec.ts` with their own Vitest config and Nx `scale-test` target, so CI's `test` and `test-integration` targets cannot pick them up. [J-2026-11-06-TST]
  Example: `pnpm nx run api-public-read:scale-test`.
- **REQ-TST-012** Scale tests are never wired into CI. [J-2026-11-06-TST]
