import { writeLog } from '@heisreal/logging';
import { loadLogKeys } from '@heisreal/logging/event';
import { readSecret } from '@heisreal/secrets/read';
import { e2eFixtures } from './config';

/**
 * Reads the log keys at start-up (instrumentation.ts `register`), as the APIs do
 * (`loadLogKeys`): the secret names in `LOG_HMAC_SECRET` and `LOG_SEARCH_HMAC_SECRET` (set by
 * OpenTofu), read from Secret Manager in `GCP_PROJECT`. Deployed (Cloud Run sets `K_SERVICE`)
 * without both, this throws and the server doesn't start. The e2e server that turns rate limits
 * on sets `K_SERVICE` too, but runs on fixtures (`E2E_FIXTURES`, never set by OpenTofu): it uses
 * the development keys like any local run.
 */
export async function loadWebLogKeys(): Promise<void> {
  const { warning } = await loadLogKeys({
    deployed: !!process.env['K_SERVICE'] && !e2eFixtures(),
    read: (name) => readSecret(name),
  });
  if (warning) writeLog('WARNING', warning, { event: 'startup' });
}
