import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import type { Mock } from 'vitest';
import { PersonSessions } from './person';

function connection(authenticate: Mock) {
  const session = {
    authenticate,
    query: vi.fn().mockReturnValue({ collect: async () => ['user:ann'] }),
    invalidate: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session,
    db: {
      newSession: vi.fn().mockResolvedValue(session),
    } as unknown as Surreal,
  };
}

const request = () => ({ headers: {} }) as Request;

describe('PersonSessions', () => {
  const person = { clerkUserId: 'user_ann', token: 'jwt' };

  it('opens a fresh session with the person’s token, passes $auth, and always closes it', async () => {
    const authenticator = { authenticate: vi.fn().mockResolvedValue(person) };
    const { db, session } = connection(vi.fn().mockResolvedValue(undefined));
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
});
