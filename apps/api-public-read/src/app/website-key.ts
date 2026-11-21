import type { WebsiteKey } from '@heisreal/http';
import type { SecretsService } from '@heisreal/secrets';

/** How often the key is read again, so a new version is picked up without a redeploy. */
const WEBSITE_KEY_MAX_AGE_MS = 5 * 60_000;

/**
 * The website key (RL-8 A, Joel 2026-11-21): web's server sends it to api-public-read so its
 * calls share the `website` allowance instead of being counted per address as web's own one.
 * OpenTofu makes it in Secret Manager (`website-key`) and sets its name in `WEBSITE_KEY_SECRET`.
 * Unset (local runs, tests) = no website key: everyone is an ordinary caller. A key that can't be
 * read is the same, for that request; the next request tries again.
 */
export function websiteKeyFromSecret(
  secrets: SecretsService,
  name = process.env['WEBSITE_KEY_SECRET']?.trim(),
): WebsiteKey {
  if (!name) return async () => undefined;
  return async () =>
    (
      await secrets.get(name, 'latest', { maxAgeMs: WEBSITE_KEY_MAX_AGE_MS })
    ).trim() || undefined;
}
