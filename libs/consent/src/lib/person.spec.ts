import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { PersonSessions, SignInUnavailable } from './person';

function connection(authenticate: jest.Mock) {
  const session = {
    authenticate,
    query: jest.fn().mockReturnValue({ collect: async () => ['user:ann'] }),
    invalidate: jest.fn().mockResolvedValue(undefined),
    closeSession: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session,
    db: {
      newSession: jest.fn().mockResolvedValue(session),
    } as unknown as Surreal,
  };
}

const request = () => ({ headers: {} }) as Request;

describe('SignInUnavailable (the default without an authenticator)', () => {
  it('refuses everyone with 401', async () => {
    await expect(new SignInUnavailable().authenticate()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('PersonSessions', () => {
  const person = { clerkUserId: 'user_ann', token: 'jwt' };

  it('verifies a request once, however often it is used (guard + handler)', async () => {
    const authenticator = { authenticate: jest.fn().mockResolvedValue(person) };
    const { db } = connection(jest.fn().mockResolvedValue(undefined));
    const people = new PersonSessions(db, authenticator);
    const req = request();
    await people.run(req, async () => 1);
    await people.run(req, async () => 2);
    expect(authenticator.authenticate).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh session with the person’s token, passes $auth, and always closes it', async () => {
    const authenticator = { authenticate: jest.fn().mockResolvedValue(person) };
    const { db, session } = connection(jest.fn().mockResolvedValue(undefined));
    const people = new PersonSessions(db, authenticator);
    await expect(
      people.run(request(), async ({ user }) => {
        throw new Error(`boom for ${String(user)}`);
      }),
    ).rejects.toThrow('boom for user:ann');
    expect(session.authenticate).toHaveBeenCalledWith('jwt');
    expect(session.invalidate).toHaveBeenCalled();
    expect(session.closeSession).toHaveBeenCalled();
  });

  it('answers 401 when SurrealDB refuses the token (unknown or erased person, expired)', async () => {
    const authenticator = { authenticate: jest.fn().mockResolvedValue(person) };
    const { db } = connection(
      jest
        .fn()
        .mockRejectedValue(
          new Error('There was a problem with authentication'),
        ),
    );
    const people = new PersonSessions(db, authenticator);
    await expect(people.run(request(), async () => 1)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not turn errors from the work itself into 401s', async () => {
    const authenticator = { authenticate: jest.fn().mockResolvedValue(person) };
    const { db } = connection(jest.fn().mockResolvedValue(undefined));
    const people = new PersonSessions(db, authenticator);
    await expect(
      people.run(request(), async () => {
        throw new Error('token bucket exhausted');
      }),
    ).rejects.toThrow('token bucket exhausted');
  });
});
