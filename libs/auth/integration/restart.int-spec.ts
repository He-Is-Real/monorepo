import { UnauthorizedException } from '@nestjs/common';
import {
  connectDatabase,
  DatabaseAvailability,
  isDatabaseUnavailable,
} from '@heisreal/database';
import {
  type DatabaseRelay,
  databaseRelay,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import type { SecretsService } from '@heisreal/secrets';
import type { Request } from 'express';
import { Surreal } from 'surrealdb';
import { ApiUserAuthenticator } from '../src/lib/clerk-authenticator';
import { parseClerkConfig } from '../src/lib/clerk-config';
import { newTestClerk } from '../src/testing';

/**
 * SurrealDB on Spot (Joel, 2026-11-07): a sign-in whose person lookup is waiting on the
 * database when it goes away ends at once as "restarting" (503 service_restarting), instead of
 * hanging until the database is back, and is refused, never let through. Token checks still come
 * first. The database "restarts" behind a TCP relay (`databaseRelay`).
 */
describe('sign-in while the database restarts', () => {
  let t: TestDatabase;
  let database: DatabaseRelay;
  let db: Surreal;
  let availability: DatabaseAvailability;

  beforeAll(async () => {
    t = await TestDatabase.create();
    database = await databaseRelay(t.url);
    const password = t.servicePasswords.get('api_user');
    db = await connectDatabase(
      new Surreal(),
      {
        url: database.url,
        namespace: t.namespace,
        database: t.database,
        username: 'api_user',
        passwordSecret: 'unused',
      },
      { get: async () => password } as unknown as SecretsService,
    );
    availability = new DatabaseAvailability(db);
    availability.onModuleInit();
  });
  afterAll(async () => {
    availability?.onModuleDestroy();
    await db?.close();
    await database?.close();
    await t?.close();
  });

  it('ends a person lookup in flight with "restarting" when the database goes, and refuses bad tokens as before', async () => {
    const clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    const config = parseClerkConfig({
      issuer: clerk.issuer,
      publicKeyPem: clerk.publicKeyPem,
      authorizedParties: clerk.authorizedParty,
    });
    const auth = new ApiUserAuthenticator(config, db, availability);
    const request = (token: string) =>
      ({ headers: { authorization: `Bearer ${token}` } }) as Request;

    // A newcomer, so their row is looked up (and made): the lookup's query never arrives.
    const sent = database.hold();
    const signingIn = auth.authenticate(
      request(clerk.token('user_midrestart')),
    );
    const outcome = signingIn.then(
      () => 'let through',
      (err: unknown) => err,
    );
    await sent;
    database.stop();
    const err = await outcome;
    expect(isDatabaseUnavailable(err)).toBe(true);

    // While it's away: a bad token is still a 401, a good one is "restarting".
    await expect(
      auth.authenticate(
        request(
          clerk.token('user_expired', {
            exp: Math.floor(Date.now() / 1000) - 60,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.authenticate(request(clerk.token('user_midrestart'))),
    ).rejects.toSatisfy(isDatabaseUnavailable);

    database.start();
    await expect
      .poll(() => availability.isUnavailable(), { timeout: 20_000 })
      .toBe(false);
    const person = await auth.authenticate(
      request(clerk.token('user_midrestart')),
    );
    expect(person.clerkUserId).toBe('user_midrestart');
  });
});
