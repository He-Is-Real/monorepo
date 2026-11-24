import { writeLog } from '@heisreal/logging';
import { loadLogKeys } from '@heisreal/logging/event';
import { readSecret } from '@heisreal/secrets/read';
import { e2eFixtures } from './config';

/**
 * Reads the log keys at start-up (instrumentation.ts `register`), as the APIs do
 * (`loadLogKeys`): the secret names in `LOG_HMAC_SECRET` and `LOG_SEARCH_HMAC_SECRET` (set by
 * OpenTofu), read from Secret Manager in `GCP_PROJECT`. The e2e server that turns rate limits
 * on sets `K_SERVICE` too, but runs on fixtures (`E2E_FIXTURES`, never set by OpenTofu): it uses
 * the development keys like any local run.
 *
 * If the keys can't be loaded (deployed without both names, or a secret can't be read), the
 * process exits. Next catches an error thrown from `register` and keeps serving, so throwing
 * isn't enough: a deployed website without its keys would answer Cloud Run's start-up probe and
 * then fail every page. Exiting makes the instance fail to start, like the APIs.
 */
export async function loadWebLogKeys(): Promise<void> {
  try {
    const { warning } = await loadLogKeys({
      deployed: !!process.env['K_SERVICE'] && !e2eFixtures(),
      read: (name) => readSecret(name),
    });
    if (warning) writeLog('WARNING', warning, { event: 'startup' });
  } catch (err) {
    writeLog(
      'CRITICAL',
      'The website could not load its log keys and will not start',
      {
        event: 'startup',
        error: {
          type: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
        },
      },
    );
    process.exit(1);
  }
}
