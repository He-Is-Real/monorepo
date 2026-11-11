import { ClerkStaffApi } from './staff-clerk';

interface User {
  id: string;
  email: string;
  role: string | null;
}
interface Invitation {
  id: string;
  email: string;
  role: string | null;
  status: 'pending' | 'revoked';
}

/**
 * Clerk's Backend API as the staff client uses it (users, their metadata, invitations), in
 * memory. `refuse` makes a matching request answer 500, the way a Clerk outage would.
 */
class FakeClerkApi {
  users: User[] = [];
  invitations: Invitation[] = [];
  refuse: (method: string, path: string) => boolean = () => false;
  private next = 1;

  invite(email: string, role: string) {
    const inv: Invitation = {
      id: `inv_${this.next++}`,
      email,
      role,
      status: 'pending',
    };
    this.invitations.push(inv);
    return inv;
  }
  pending(email: string) {
    return this.invitations
      .filter((i) => i.email === email && i.status === 'pending')
      .map((i) => i.role);
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/v1/, '');
    const answer = (status: number, body?: unknown) =>
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
      });
    if (this.refuse(method, path)) return answer(500);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
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
                verification: { status: 'verified' },
              },
            ],
          })),
      );
    }
    const metadata = path.match(/^\/users\/(user_\w+)\/metadata$/);
    if (method === 'PATCH' && metadata) {
      const user = this.users.find((u) => u.id === metadata[1]);
      if (!user) return answer(404);
      user.role = body.public_metadata.role;
      return answer(200, {});
    }
    if (method === 'GET' && path === '/invitations') {
      return answer(200, {
        data: this.invitations
          .filter(
            (i) =>
              i.status === url.searchParams.get('status') &&
              i.email.includes(url.searchParams.get('query') ?? ''),
          )
          .map((i) => ({
            id: i.id,
            email_address: i.email,
            public_metadata: { role: i.role },
          })),
      });
    }
    if (method === 'POST' && path === '/invitations') {
      const inv = this.invite(body.email_address, body.public_metadata.role);
      return answer(200, { id: inv.id });
    }
    const revoke = path.match(/^\/invitations\/(inv_\w+)\/revoke$/);
    if (method === 'POST' && revoke) {
      const inv = this.invitations.find((i) => i.id === revoke[1]);
      if (!inv) return answer(404);
      inv.status = 'revoked';
      return answer(200, {});
    }
    return answer(404);
  }) as typeof fetch;
}

/**
 * The staff client against a fake Clerk: a role reaches every account with the email, and the
 * email's pending invitations never carry a role other than the one set; a command Clerk refuses
 * part-way leaves the invitations as they were.
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

  it('removing someone with an account also revokes their pending invitations', async () => {
    clerk.users.push({ id: 'user_ann', email: ann, role: 'Admin' });
    clerk.invite(ann, 'Admin');
    await api.setRole(ann, null);
    expect(clerk.users[0].role).toBe(null);
    expect(clerk.pending(ann)).toEqual([]);
  });

  it('changing the role of someone with an account leaves no invitation carrying the old role', async () => {
    clerk.users.push({ id: 'user_ann', email: ann, role: 'Admin' });
    clerk.invite(ann, 'Admin');
    await api.setRole(ann, 'Moderator');
    expect(clerk.users[0].role).toBe('Moderator');
    expect(clerk.pending(ann)).not.toContain('Admin');
  });

  it('replaces an invitation’s role, and removing someone with no account revokes it', async () => {
    clerk.invite(ann, 'Moderator');
    await api.setRole(ann, 'Admin');
    expect(clerk.pending(ann)).toEqual(['Admin']);
    await api.setRole(ann, 'Admin');
    expect(clerk.pending(ann)).toEqual(['Admin']);
    await api.setRole(ann, null);
    expect(clerk.pending(ann)).toEqual([]);
  });

  it('keeps the old invitation when Clerk refuses the new one', async () => {
    clerk.invite(ann, 'Moderator');
    clerk.refuse = (method, path) =>
      method === 'POST' && path === '/invitations';
    await expect(api.setRole(ann, 'Admin')).rejects.toThrow();
    expect(clerk.pending(ann)).toEqual(['Moderator']);
  });

  it('withdraws the new invitation when Clerk refuses to revoke the old one', async () => {
    clerk.invite(ann, 'Moderator');
    clerk.refuse = (method, path) =>
      method === 'POST' && path === '/invitations/inv_1/revoke';
    await expect(api.setRole(ann, 'Admin')).rejects.toThrow();
    expect(clerk.pending(ann)).toEqual(['Moderator']);
  });
});
