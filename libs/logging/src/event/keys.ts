import { createHmac } from 'node:crypto';

/**
 * The two keyed hashes (HMAC-SHA-256) the logs use (LG-2d C, LG-2g A; Joel 23–24 Nov 2026):
 *
 * - the general key (Secret Manager `log-hmac`, prefix `hk1:`): `user.session_hash`,
 *   `user.token_hash` and long text written as a fingerprint (`story.body_hash`);
 * - the search-only key (`log-search-hmac`, prefix `hs1:`): who searched, on search events only,
 *   so those hashes never match the same person's other events.
 *
 * Never plain SHA. Until the service has read the real keys ({@link setLogKeys}, done at start-up
 * by `@heisreal/http`'s `WideEventsModule`), fixed development keys are used: local runs and tests
 * never need a real key, and their hashes mean nothing outside the machine that made them.
 */
export interface LogKeys {
  /** `log-hmac`: the general key. */
  general: string;
  /** `log-search-hmac`: the search-only key. */
  search: string;
}

/** Public, fixed keys for local runs and tests (never a real one). */
export const DEV_LOG_KEYS: LogKeys = Object.freeze({
  general: 'heisreal-dev-log-hmac-not-secret',
  search: 'heisreal-dev-log-search-hmac-not-secret',
});

let keys: LogKeys = DEV_LOG_KEYS;

/** Uses these keys from now on (empty values keep the current key). */
export function setLogKeys(next: Partial<LogKeys>): void {
  keys = {
    general: next.general?.trim() || keys.general,
    search: next.search?.trim() || keys.search,
  };
}

/** Back to the development keys (tests). */
export function resetLogKeys(): void {
  keys = DEV_LOG_KEYS;
}

const hmac = (key: string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest('hex');

/** `hk1:` + 64 hex: a keyed hash with the general key (`log-hmac`). */
export function logHash(value: string): string {
  return `hk1:${hmac(keys.general, value)}`;
}

/** `hs1:` + 64 hex: a keyed hash with the search-only key (`log-search-hmac`). */
export function searchHash(value: string): string {
  return `hs1:${hmac(keys.search, value)}`;
}
