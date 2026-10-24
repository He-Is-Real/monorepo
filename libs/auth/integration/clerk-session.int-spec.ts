import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PersonSessions } from '@heisreal/consent';
import {
  createPeople,
  ERASE,
  rows,
  run,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import {
  ApiAdminAuthenticator,
  ApiUserAuthenticator,
} from '../src/lib/clerk-authenticator';
import { parseClerkConfig } from '../src/lib/clerk-config';
import { newTestClerk, type TestClerk } from '../src/testing';

/**
 * Task 0.5 end to end on SurrealDB 3.2.4: a token verified by `libs/auth` opens the person's
 * own database session (D27). The stand-in Clerk key is the one the harness pins as the
 * database's `clerk_jwt_public_key`, exactly as OpenTofu pins the dev instance's.
 */
describe('Clerk sign-in → person session', () => {
  let t: TestDatabase;
  let clerk: TestClerk;
  let apiUser: Surreal;
  let apiAdmin: Surreal;
  let migrator: Surreal;
  let config: ReturnType<typeof parseClerkConfig>;

  const request = (token: string) =>
    ({ headers: { authorization: `Bearer ${token}` } }) as Request;
  const usersFor = async (clerkUserId: string) =>
    rows(migrator, `SELECT id FROM user WHERE clerkUserId = $clerkUserId`, {
      clerkUserId,
    });

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    config = parseClerkConfig({
      issuer: clerk.issuer,
      publicKeyPem: clerk.publicKeyPem,
      authorizedParties: clerk.authorizedParty,
    });
    apiUser = await t.service('api_user');
    apiAdmin = await t.service('api_admin');
    migrator = await t.migrator();
    await createPeople(t, { ann: 'user_ann', mod: 'user_mod' });
  });
  afterAll(() => t?.close());

  describe('api-user', () => {
    it('creates a newcomer’s user row on api-user’s login, then runs as them', async () => {
      const auth = new ApiUserAuthenticator(config, apiUser);
      const people = new PersonSessions(apiUser, auth);
      expect(await usersFor('user_newcomer')).toHaveLength(0);

      const req = request(clerk.token('user_newcomer'));
      const seen = await people.run(req, async ({ session, user }) => ({
        user: String(user),
        rows: await rows(session, 'SELECT id, clerkUserId FROM user'),
      }));

      const [created] = await usersFor('user_newcomer');
      expect(seen.user).toBe(String(created['id']));
      // The person's session sees only their own row (D27), and the row holds only the id (D16).
      expect(seen.rows).toEqual([
        { id: created['id'], clerkUserId: 'user_newcomer' },
      ]);
    });

    it('signs in an existing person without creating another row', async () => {
      const auth = new ApiUserAuthenticator(config, apiUser);
      const people = new PersonSessions(apiUser, auth);
      const user = await people.run(
        request(clerk.token('user_ann')),
        async ({ user }) => String(user),
      );
      expect(user).toBe('user:ann');
      expect(await usersFor('user_ann')).toHaveLength(1);
    });

    it('creates exactly one row when a newcomer’s first requests race', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          // A fresh authenticator each, so none is answered from another's cache.
          new ApiUserAuthenticator(config, apiUser).authenticate(
            request(clerk.token('user_racer')),
          ),
        ),
      );
      expect(results.every((r) => r.clerkUserId === 'user_racer')).toBe(true);
      expect(await usersFor('user_racer')).toHaveLength(1);
    });

    it('SurrealDB itself refuses a token our checks would accept but it can’t verify (wrong ns)', async () => {
      const auth = new ApiUserAuthenticator(config, apiUser);
      const people = new PersonSessions(apiUser, auth);
      await expect(
        people.run(
          request(clerk.token('user_ann', { ns: 'elsewhere' })),
          async () => 1,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('an erased person’s still-valid token gets a new, empty row (closed by the user.deleted erasure, D39)', async () => {
      await createPeople(t, { gone: 'user_gone' });
      await run(apiUser, ERASE, {
        clerkUserId: 'user_gone',
        reason: 'account_deleted',
      });
      const auth = new ApiUserAuthenticator(config, apiUser);
      const people = new PersonSessions(apiUser, auth);
      const user = await people.run(
        request(clerk.token('user_gone')),
        async ({ user }) => String(user),
      );
      // Not the erased stub: a fresh row with nothing in it. The stub stays erased.
      expect(user).not.toBe('user:gone');
      const [stub] = await rows(
        migrator,
        'SELECT clerkUserId, gdprDeletedAt FROM user:gone',
      );
      expect(stub['clerkUserId']).toBeUndefined();
      expect(stub['gdprDeletedAt']).toBeDefined();
    });
  });

  describe('api-admin', () => {
    it('signs in a person who has a row, with their role, and creates none', async () => {
      const auth = new ApiAdminAuthenticator(config, apiAdmin);
      const people = new PersonSessions(apiAdmin, auth);
      const req = request(clerk.token('user_mod', { role: 'Moderator' }));
      expect(await auth.authenticate(req)).toMatchObject({
        clerkUserId: 'user_mod',
        role: 'Moderator',
      });
      expect(await people.run(req, async ({ user }) => String(user))).toBe(
        'user:mod',
      );
    });

    it('answers 403 for a person without a row, and never creates one', async () => {
      const auth = new ApiAdminAuthenticator(config, apiAdmin);
      await expect(
        auth.authenticate(
          request(clerk.token('user_stranger', { role: 'Admin' })),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await usersFor('user_stranger')).toHaveLength(0);
    });
  });
});
