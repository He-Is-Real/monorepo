import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { newTestClerk } from '../testing';
import {
  ApiAdminAuthenticator,
  ApiUserAuthenticator,
  bearerToken,
} from './clerk-authenticator';
import { parseClerkConfig } from './clerk-config';

const clerk = newTestClerk();
const config = parseClerkConfig({
  issuer: clerk.issuer,
  publicKeyPem: clerk.publicKeyPem,
  authorizedParties: clerk.authorizedParty,
});

const request = (authorization?: string) =>
  ({
    headers: authorization === undefined ? {} : { authorization },
  }) as Request;

/**
 * A stand-in for the service's SurrealDB connection: answers each query from `answer`, in the
 * JSON shape `runQuery` reads.
 */
function database(answer: (sql: string) => unknown) {
  const queries: string[] = [];
  const db = {
    query: (sql: string) => ({
      json: () => ({
        responses: async () => {
          queries.push(sql);
          const result = answer(sql);
          if (result instanceof Error)
            return [{ success: false, error: result }];
          return [{ success: true, result }];
        },
      }),
    }),
  } as unknown as Surreal;
  return { db, queries };
}

describe('bearerToken', () => {
  it('reads Authorization: Bearer', () => {
    expect(bearerToken(request('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    'Basic abc',
    'bearer abc',
    'Bearer a b',
  ])('refuses %p with 401', (header) => {
    expect(() => bearerToken(request(header))).toThrow(UnauthorizedException);
  });
});

describe('ApiUserAuthenticator', () => {
  it('verifies the token, creates the user row on first use, and returns the token', async () => {
    const { db, queries } = database((sql) =>
      sql.startsWith('SELECT') ? [] : ['user:new'],
    );
    const token = clerk.token('user_ann');
    const auth = new ApiUserAuthenticator(config, db);
    await expect(
      auth.authenticate(request(`Bearer ${token}`)),
    ).resolves.toEqual({
      clerkUserId: 'user_ann',
      token,
      role: 'User',
    });
    expect(queries).toEqual([
      expect.stringMatching(
        /^SELECT VALUE id FROM user WHERE clerkUserId = \$clerkUserId/,
      ),
      expect.stringMatching(/^CREATE user SET clerkUserId = \$clerkUserId/),
    ]);
  });

  it('does not create a row that exists, and remembers known people', async () => {
    const { db, queries } = database(() => ['user:ann']);
    const auth = new ApiUserAuthenticator(config, db);
    await auth.authenticate(request(`Bearer ${clerk.token('user_ann')}`));
    await auth.authenticate(request(`Bearer ${clerk.token('user_ann')}`));
    expect(queries).toHaveLength(1);
  });

  it('reads the winner’s row when a concurrent first request created it', async () => {
    let selects = 0;
    const { db } = database((sql) => {
      if (sql.startsWith('SELECT')) return selects++ ? ['user:winner'] : [];
      return new Error(
        "Database index `user_clerk` already contains 'user_ann'",
      );
    });
    const auth = new ApiUserAuthenticator(config, db);
    await expect(
      auth.authenticate(request(`Bearer ${clerk.token('user_ann')}`)),
    ).resolves.toMatchObject({ clerkUserId: 'user_ann' });
  });

  it('refuses a bad token with 401 without touching the database', async () => {
    const { db, queries } = database(() => ['user:ann']);
    const auth = new ApiUserAuthenticator(config, db);
    for (const token of [
      clerk.token('user_ann', { exp: 1 }),
      clerk.token('user_ann', { azp: 'https://evil.example' }),
      newTestClerk().token('user_ann'),
      clerk.token('user_ann', { role: undefined }),
    ]) {
      await expect(
        auth.authenticate(request(`Bearer ${token}`)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(queries).toEqual([]);
  });

  it('fails closed (not 401, not signed in) when the database fails', async () => {
    const { db } = database(() => new Error('connection lost'));
    const auth = new ApiUserAuthenticator(config, db);
    await expect(
      auth.authenticate(request(`Bearer ${clerk.token('user_ann')}`)),
    ).rejects.toThrow('connection lost');
  });
});

describe('ApiAdminAuthenticator', () => {
  it('signs in a known person and never creates rows', async () => {
    const { db, queries } = database(() => ['user:mod']);
    const auth = new ApiAdminAuthenticator(config, db);
    await expect(
      auth.authenticate(
        request(`Bearer ${clerk.token('user_mod', { role: 'Moderator' })}`),
      ),
    ).resolves.toMatchObject({ clerkUserId: 'user_mod', role: 'Moderator' });
    expect(queries.every((q) => q.startsWith('SELECT'))).toBe(true);
  });

  it('answers 403 unknown_person for someone without a user row', async () => {
    const { db, queries } = database(() => []);
    const auth = new ApiAdminAuthenticator(config, db);
    const err = await auth
      .authenticate(
        request(`Bearer ${clerk.token('user_new', { role: 'Admin' })}`),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'unknown_person',
    });
    expect(queries.some((q) => q.startsWith('CREATE'))).toBe(false);
  });
});
