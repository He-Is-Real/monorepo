import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { newTestClerk } from '../testing';
import { ApiUserAuthenticator, bearerToken } from './clerk-authenticator';
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
  it('fails closed (not 401, not signed in) when the database fails', async () => {
    const { db } = database(() => new Error('connection lost'));
    const auth = new ApiUserAuthenticator(config, db);
    await expect(
      auth.authenticate(request(`Bearer ${clerk.token('user_ann')}`)),
    ).rejects.toThrow('connection lost');
  });
});
