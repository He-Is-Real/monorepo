import {
  Global,
  Injectable,
  Module,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { writeLog } from '@heisreal/logging';
import { setLogKeys } from '@heisreal/logging/event';
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
    const general = process.env['LOG_HMAC_SECRET']?.trim();
    const search = process.env['LOG_SEARCH_HMAC_SECRET']?.trim();
    if (process.env['K_SERVICE'] && (!general || !search)) {
      throw new Error(
        'Log keys not set: a deployed service needs LOG_HMAC_SECRET and LOG_SEARCH_HMAC_SECRET (their Secret Manager names)',
      );
    }
    if ((general || search) && !this.secrets) {
      throw new Error('LOG_HMAC_SECRET needs SecretsModule');
    }
    const read = async (name: string | undefined) =>
      name && this.secrets ? (await this.secrets.get(name)).trim() : undefined;
    const [generalKey, searchKey] = await Promise.all([
      read(general),
      read(search),
    ]);
    if ((general && !generalKey) || (search && !searchKey)) {
      throw new Error('A log key secret is empty');
    }
    setLogKeys({ general: generalKey, search: searchKey });
    if (!general || !search) {
      writeLog(
        'WARNING',
        'Log keys not set (LOG_HMAC_SECRET, LOG_SEARCH_HMAC_SECRET): hashes use the development keys (local only; a deployed service won’t start)',
        { event: 'startup' },
      );
    }
  }
}

/** Import once in an API's app module: loads the log keys. */
@Global()
@Module({ providers: [LogKeysLoader] })
export class LogKeysModule {}
