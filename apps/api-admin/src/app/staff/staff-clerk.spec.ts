import { ClerkStaffApi } from './staff-clerk';

interface User {
  id: string;
  email: string;
  verified: boolean;
  role: string | null;
}

/** Clerk's Backend API as the staff client uses it (users and their metadata), in memory. */
class FakeClerkApi {
  users: User[] = [];

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/v1/, '');
    const answer = (status: number, body?: unknown) =>
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
      });
    if (method === 'GET' && path === '/users') {
      const email = url.searchParams.get('email_address');
      return answer(
        200,
        this.users
          .filter((u) => u.email === email)
          .map((u) => ({
            id: u.id,
            email_addresses: [
              {
                email_address: u.email,
                verification: {
                  status: u.verified ? 'verified' : 'unverified',
                },
              },
            ],
          })),
      );
    }
    const metadata = path.match(/^\/users\/(user_\w+)\/metadata$/);
    if (method === 'PATCH' && metadata) {
      const user = this.users.find((u) => u.id === metadata[1]);
      if (!user) return answer(404);
      user.role = JSON.parse(String(init?.body)).public_metadata.role;
      return answer(200, {});
    }
    return answer(404);
  }) as typeof fetch;
}

/**
 * The staff client against a fake Clerk: a role reaches only accounts that have proved they own
 * the email, and an email with no such account changes nothing (S-7: no invitations).
 */
describe('staff roles in Clerk', () => {
  const ann = 'ann@heisreal.today';
  let clerk: FakeClerkApi;
  let api: ClerkStaffApi;
  beforeEach(() => {
    clerk = new FakeClerkApi();
    api = new ClerkStaffApi(
      { get: async () => 'sk_test_fake' },
      'clerk-secret-key',
      clerk.fetch,
    );
  });

  it('sets and clears the role on the account with the verified email, never an unverified one', async () => {
    clerk.users.push(
      { id: 'user_ann', email: ann, verified: true, role: null },
      { id: 'user_imp', email: ann, verified: false, role: null },
    );
    expect(await api.setRole(ann, 'Admin')).toEqual({ count: 1 });
    expect(clerk.users.map((u) => u.role)).toEqual(['Admin', null]);
    expect(await api.setRole(ann, null)).toEqual({ count: 1 });
    expect(clerk.users[0].role).toBe(null);
  });

  it('changes nothing for an email with no account', async () => {
    expect(await api.setRole(ann, 'Moderator')).toEqual({ count: 0 });
  });
});
