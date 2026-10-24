// The e2e servers (playwright.config.ts starts them): the built site four times over, each
// against a port of the stub api-public-read (stub-api.mjs). E2E_PORT_BASE moves them all, so
// two checkouts can run the suite at once (default 4300).
const base = Number(process.env['E2E_PORT_BASE'] ?? 4300);

export const STUB_PORT = base + 10;
export const STUB_LIVE_PORT = base + 11;
export const STUB_DOWN_PORT = base + 12;
export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

/** Dev as it is: indexing off, D48's relaxed consent checks on. Every suite's baseURL. */
export const WEB_PORT = base;
/** Go live: INDEXING=allow and D48 off (indexing.e2e.ts). */
export const WEB_LIVE_PORT = base + 1;
export const WEB_LIVE_URL = `http://localhost:${WEB_LIVE_PORT}`;
/** api-public-read down: every API request answers 503. */
export const WEB_DOWN_PORT = base + 2;
export const WEB_DOWN_URL = `http://localhost:${WEB_DOWN_PORT}`;
/** Signed in (header.e2e.ts): E2E_FIXTURES shows this name instead of Clerk's control. */
export const WEB_SIGNED_IN_PORT = base + 3;
export const WEB_SIGNED_IN_URL = `http://localhost:${WEB_SIGNED_IN_PORT}`;
/** 40 characters: long names must truncate before anything in the header wraps. */
export const SIGNED_IN_NAME = 'Bartholomew Montgomery-Fitzwilliam Smith';
