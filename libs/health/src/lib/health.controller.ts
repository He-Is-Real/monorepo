import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { NoRoleRequired } from '@heisreal/auth';
import { NoConsentRequired } from '@heisreal/consent';
import { DatabaseHealthService, DatabaseStatus } from '@heisreal/database';
import type { Response } from 'express';
import { SERVICE_NAME } from './health.constants';

/** Matches the `Health` schema in the OpenAPI contracts (components.yaml). */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  db: DatabaseStatus;
}

// D21: api-user and api-admin require a consent decision on every route, this probe included,
// and api-admin a role decision (D1).
@NoConsentRequired('health probe: reads no personal data')
@NoRoleRequired('health probe for Cloud Run and uptime checks')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly service: string,
    private readonly database: DatabaseHealthService,
  ) {}

  /** Readiness: 200 when the database is reachable with this service's credentials, 503 otherwise. */
  @Get()
  async get(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponse> {
    const db = await this.database.check();
    if (db === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      service: this.service,
      db,
    };
  }
}
