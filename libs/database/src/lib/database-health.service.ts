import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { SURREAL } from './database.constants';

export type DatabaseStatus = 'up' | 'down';

/** A health check must answer quickly: while the SDK is reconnecting, queries wait indefinitely. */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class DatabaseHealthService {
  private readonly logger = new Logger(DatabaseHealthService.name);

  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  /** Runs a trivial authenticated query, so both reachability and the service's credentials are verified. */
  async check(timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<DatabaseStatus> {
    try {
      await withTimeout(
        this.db.query('RETURN true'),
        timeoutMs,
        'Database health check',
      );
      return 'up';
    } catch (err) {
      this.logger.warn(`Database health check failed: ${String(err)}`);
      return 'down';
    }
  }
}
