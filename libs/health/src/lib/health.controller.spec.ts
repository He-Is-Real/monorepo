import { HttpStatus } from '@nestjs/common';
import type { DatabaseHealthService, DatabaseStatus } from '@heisreal/database';
import type { Response } from 'express';
import { HealthController } from './health.controller';

function setup(db: DatabaseStatus, relaxed?: boolean) {
  const database = {
    check: jest.fn().mockResolvedValue(db),
    consentChecksRelaxed: jest.fn().mockResolvedValue(relaxed),
  };
  const res = { status: jest.fn() };
  const controller = new HealthController(
    'api-public-read',
    database as unknown as DatabaseHealthService,
  );
  return { controller, res, database };
}

describe('HealthController', () => {
  it('returns ok with 200 when the database is up, with the consent setting (D48)', async () => {
    const { controller, res } = setup('up', false);
    await expect(controller.get(res as unknown as Response)).resolves.toEqual({
      status: 'ok',
      service: 'api-public-read',
      db: 'up',
      consentChecksRelaxed: false,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('says when consent checks are relaxed (dev only, D48)', async () => {
    const { controller, res } = setup('up', true);
    await expect(
      controller.get(res as unknown as Response),
    ).resolves.toMatchObject({ status: 'ok', consentChecksRelaxed: true });
  });

  it('leaves the setting out when the database can’t say', async () => {
    const { controller, res } = setup('up', undefined);
    expect(await controller.get(res as unknown as Response)).not.toHaveProperty(
      'consentChecksRelaxed',
    );
  });

  it('returns degraded with 503 when the database is down', async () => {
    const { controller, res, database } = setup('down');
    await expect(controller.get(res as unknown as Response)).resolves.toEqual({
      status: 'degraded',
      service: 'api-public-read',
      db: 'down',
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(database.consentChecksRelaxed).not.toHaveBeenCalled();
  });
});
