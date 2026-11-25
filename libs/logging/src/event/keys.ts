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

/**
 * Kept on `globalThis`, not in this module: the website's server bundles this library more than
 * once (its proxy and its instrumentation are separate bundles), and the keys read at start-up
 * must be the ones every copy hashes with.
 */
const KEYS = Symbol.for('heisreal.logging.keys');
type KeyHolder = { [KEYS]?: LogKeys };
const holder = globalThis as KeyHolder;
const current = (): LogKeys => holder[KEYS] ?? DEV_LOG_KEYS;

/** Uses these keys from now on (empty values keep the current key). */
export function setLogKeys(next: Partial<LogKeys>): void {
  const keys = current();
  holder[KEYS] = {
    general: next.general?.trim() || keys.general,
    search: next.search?.trim() || keys.search,
  };
}

/** Back to the development keys (tests). */
export function resetLogKeys(): void {
  holder[KEYS] = DEV_LOG_KEYS;
}

/**
 * Reads the two log keys at start-up, the same way in every service (the APIs' `LogKeysModule`,
 * the website's `instrumentation.ts`): the secret names are in `LOG_HMAC_SECRET` (`log-hmac`) and
 * `LOG_SEARCH_HMAC_SECRET` (`log-search-hmac`), set by OpenTofu, and `read` reads one from Secret
 * Manager (libs/secrets). When `deployed`, both must be set, or this throws and the service
 * doesn't start: hashes made with the public development keys could be reversed. Otherwise
 * (local runs and tests) the development keys are used, and this answers a warning to write. A
 * key that is named but empty also throws.
 */
export async function loadLogKeys({
  deployed,
  read,
  env = globalThis.process?.env ?? {},
}: {
  deployed: boolean;
  read?: (secretName: string) => Promise<string>;
  env?: Record<string, string | undefined>;
}): Promise<{ warning?: string }> {
  const general = env['LOG_HMAC_SECRET']?.trim();
  const search = env['LOG_SEARCH_HMAC_SECRET']?.trim();
  if (deployed && (!general || !search)) {
    throw new Error(
      'Log keys not set: a deployed service needs LOG_HMAC_SECRET and LOG_SEARCH_HMAC_SECRET (their Secret Manager names)',
    );
  }
  if ((general || search) && !read) {
    throw new Error('LOG_HMAC_SECRET needs a Secret Manager reader');
  }
  const get = async (name: string | undefined) =>
    name && read ? (await read(name)).trim() : undefined;
  const [generalKey, searchKey] = await Promise.all([
    get(general),
    get(search),
  ]);
  if ((general && !generalKey) || (search && !searchKey)) {
    throw new Error('A log key secret is empty');
  }
  setLogKeys({ general: generalKey, search: searchKey });
  return general && search
    ? {}
    : {
        warning:
          'Log keys not set (LOG_HMAC_SECRET, LOG_SEARCH_HMAC_SECRET): hashes use the development keys (local only; a deployed service won’t start)',
      };
}

const hmac = (key: string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest('hex');

/** `hk1:` + 64 hex: a keyed hash with the general key (`log-hmac`). */
export function logHash(value: string): string {
  return `hk1:${hmac(current().general, value)}`;
}

/** `hs1:` + 64 hex: a keyed hash with the search-only key (`log-search-hmac`). */
export function searchHash(value: string): string {
  return `hs1:${hmac(current().search, value)}`;
}
