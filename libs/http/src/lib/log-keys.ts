import {
  Global,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { flushLogSinks, writeLog } from '@heisreal/logging';
import { startAxiomLogs } from '@heisreal/logging/axiom';
import { flushTracing } from '@heisreal/logging/tracing';
import { loadLogKeys } from '@heisreal/logging/event';
import { SecretsService } from '@heisreal/secrets';

/**
 * Reads the two log keys at start-up (Secret Manager, through libs/secrets): the secret names
 * are in `LOG_HMAC_SECRET` (`log-hmac`) and `LOG_SEARCH_HMAC_SECRET` (`log-search-hmac`), set
 * by OpenTofu. A deployed service (Cloud Run sets `K_SERVICE`, as for rate limits) won't start
 * without both: hashes made with the public development keys could be reversed. Local runs and
 * tests (no `K_SERVICE`) use the fixed development keys, with a warning. A key that is named but
 * can't be read, or is empty, stops the service starting, like its other secrets.
 */
@Injectable()
export class LogKeysLoader implements OnModuleInit {
  constructor(@Optional() private readonly secrets?: SecretsService) {}

  async onModuleInit(): Promise<void> {
    const secrets = this.secrets;
    const { warning } = await loadLogKeys({
      deployed: !!process.env['K_SERVICE'],
      read: secrets ? (name) => secrets.get(name) : undefined,
    });
    if (warning) writeLog('WARNING', warning, { event: 'startup' });
  }
}

/**
 * Sends every log entry to Axiom too (LG-3, `@heisreal/logging/axiom`) where OpenTofu configured
 * it: `AXIOM_DATASET`, `AXIOM_DOMAIN`, and the token's Secret Manager name `AXIOM_TOKEN_SECRET`,
 * read through libs/secrets. A token that can't be read (no version yet) is one warning, never a
 * failed start. On shutdown (SIGTERM, Nest's shutdown hooks; Cloud Run gives the instance CPU
 * for 10 s) it sends what is still waiting, log lines and spans (LG-15, started in `main.ts`),
 * at most 3 s.
 */
@Injectable()
export class AxiomLogsLoader implements OnModuleInit, OnApplicationShutdown {
  constructor(@Optional() private readonly secrets?: SecretsService) {}

  async onModuleInit(): Promise<void> {
    const secrets = this.secrets;
    await startAxiomLogs({
      read: secrets ? (name) => secrets.get(name) : undefined,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([flushLogSinks(3000), flushTracing(3000)]);
  }
}

/** Import once in an API's app module: loads the log keys and starts the Axiom sink. */
@Global()
@Module({ providers: [LogKeysLoader, AxiomLogsLoader] })
export class LogKeysModule {}
