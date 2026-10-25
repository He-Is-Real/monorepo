// The e2e servers (playwright.config.ts starts them): the built site four times over, each
// against a port of the stub api-public-read (stub-api.mjs), and the stub api-user
// (stub-api-user.mjs) the signed-in one calls from the browser. E2E_PORT_BASE moves them all,
// so two checkouts can run the suite at once (default 4300).
const base = Number(process.env['E2E_PORT_BASE'] ?? 4300);

export const STUB_PORT = base + 10;
export const STUB_LIVE_PORT = base + 11;
export const STUB_DOWN_PORT = base + 12;
export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
/** The stub api-user (stub-api-user.mjs), for the signed-in server's browser calls. */
export const STUB_USER_PORT = base + 13;
export const STUB_USER_URL = `http://127.0.0.1:${STUB_USER_PORT}`;
/** The fixtures' signed-in person (account-control.tsx, E2E_FIXTURE_USER_ID). */
export const E2E_FIXTURE_USER_ID = 'user_e2efixture';
/**
 * A fixture token as the browser's fixture makes it (account-control.tsx): unsigned, its payload
 * the person (`sub`) and an optional session, so each test's hearts stay its own at the stub.
 */
export const fixtureToken = (session = '', sub = E2E_FIXTURE_USER_ID) =>
  `e2e.${Buffer.from(JSON.stringify({ sub, session })).toString('base64url')}.fixture`;

/** Dev as it is: indexing off, D48 on, the E2E_FIXTURES stand-in for Clerk. Every suite's baseURL. */
export const WEB_PORT = base;
/** Go live: INDEXING=allow and D48 off (indexing.e2e.ts). */
export const WEB_LIVE_PORT = base + 1;
export const WEB_LIVE_URL = `http://localhost:${WEB_LIVE_PORT}`;
/** api-public-read down: every API request answers 503. */
export const WEB_DOWN_PORT = base + 2;
export const WEB_DOWN_URL = `http://localhost:${WEB_DOWN_PORT}`;
/**
 * Signed in (header.e2e.ts, account.e2e.ts): E2E_FIXTURES shows this name instead of Clerk's
 * control, and the browser calls the stub api-user's account bootstrap with the fixture token.
 */
export const WEB_SIGNED_IN_PORT = base + 3;
export const WEB_SIGNED_IN_URL = `http://localhost:${WEB_SIGNED_IN_PORT}`;
/** 40 characters: long names must truncate before anything in the header wraps. */
export const SIGNED_IN_NAME = 'Bartholomew Montgomery-Fitzwilliam Smith';

/**
 * Every e2e server's clock for "new" (E2E_NOW, read only with E2E_FIXTURES; D72: a card says
 * NEW for its story's first 7 days), so the badge is the same locally and in CI, whatever the
 * date. The stub's `tag=new-test` stories are dated around it.
 */
export const E2E_NOW = '2026-10-25T12:00:00Z';
