import { HttpStatus } from '@nestjs/common';
import type { DatabaseHealthService, DatabaseStatus } from '@heisreal/database';
import type { Response } from 'express';
import { HealthController } from './health.controller';

function setup(db: DatabaseStatus) {
  const database = { check: jest.fn().mockResolvedValue(db) };
  const res = { status: jest.fn() };
  const controller = new HealthController(
    'api-read',
    database as unknown as DatabaseHealthService,
  );
  return { controller, res };
}

describe('HealthController', () => {
  it('returns ok with 200 when the database is up', async () => {
    const { controller, res } = setup('up');
    await expect(controller.get(res as unknown as Response)).resolves.toEqual({
      status: 'ok',
      service: 'api-read',
      db: 'up',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns degraded with 503 when the database is down', async () => {
    const { controller, res } = setup('down');
    await expect(controller.get(res as unknown as Response)).resolves.toEqual({
      status: 'degraded',
      service: 'api-read',
      db: 'down',
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
