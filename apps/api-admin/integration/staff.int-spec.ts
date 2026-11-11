import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  createPeople,
  rows,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';
import {
  STAFF_CLERK,
  type StaffClerk,
  type StaffRole,
} from '../src/app/staff/staff-clerk';
import { StaffBaseline } from '../src/app/staff/staff.controller';

/**
 * Clerk as api-admin sees it: each email's role (Clerk is never called in tests). Every email has
 * an account with it verified, except those in `noAccount`, whose roles Clerk never holds.
 */
class FakeClerk implements StaffClerk {
  readonly enabled = true;
  roles = new Map<string, StaffRole | null>();
  noAccount = new Set<string>();
  failing = false;
  /** Once: after setting this email's role, wait at `gate` (a slow Clerk answer). */
  hold: {
    email: string;
    role: StaffRole | null;
    reached: () => void;
    gate: Promise<void>;
  } | null = null;
  /** Runs before each change reaches Clerk; throwing is Clerk failing (nothing changed). */
  beforeSet: ((email: string, role: StaffRole | null) => Promise<void>) | null =
    null;
  async setRole(email: string, role: StaffRole | null) {
    if (this.failing) throw new Error('Clerk answered 500');
    await this.beforeSet?.(email, role);
    if (this.noAccount.has(email)) return { count: 0 };
    this.roles.set(email, role);
    const hold = this.hold;
    if (hold && hold.email === email && hold.role === role) {
      this.hold = null;
      hold.reached();
      await hold.gate;
    }
    return { count: 1 };
  }
}

/**
 * The Staff page's routes (S-1 to S-4, G7, G8 B, G24; Joel 2026-11-11) through api-admin's real
 * AppModule on its own login and a real SurrealDB, with Clerk faked at its one client: each change
 * goes to Clerk first, then the list; the baseline admins are put back on every start; only
 * Admins may use any of it. Every answer is checked against api-admin.yaml.
 */
describe('the staff list (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  const fake = new FakeClerk();
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let baseline: StaffBaseline;
  let url: string;

  const as = (sub: string, role: string, email?: string) => ({
    authorization: `Bearer ${clerk.token(sub, {
      role,
      ...(email ? { email, email_verified: true } : {}),
    })}`,
  });
  const admin = () => as('user_admin', 'Admin', 'joel@heisreal.today');

  async function call(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    who: Record<string, string> = admin(),
    body?: unknown,
  ) {
    const res = await fetch(`${url}/v1/admin/staff${path}`, {
      method,
      headers: {
        ...who,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  const put = (email: string, role: unknown, who = admin()) =>
    call('PUT', `/${encodeURIComponent(email)}`, who, { role });
  const remove = (email: string, who = admin()) =>
    call('DELETE', `/${encodeURIComponent(email)}`, who);
  const table = () =>
    rows<{ email: string; role: string }>(
      migrator,
      'SELECT email, role FROM staffMember ORDER BY email',
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    await createPeople(t, { admin: 'user_admin', moderator: 'user_mod' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_admin'))
      .overrideProvider(CLERK_CONFIG)
      .useValue(
        parseClerkConfig({
          issuer: clerk.issuer,
          publicKeyPem: clerk.publicKeyPem,
          authorizedParties: clerk.authorizedParty,
        }),
      )
      .overrideProvider(STAFF_CLERK)
      .useValue(fake)
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    useBodyParser(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    baseline = app.get(StaffBaseline);
    await baseline.done;
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('on start, makes the baseline admins Admin in Clerk and on the list (S-4)', async () => {
    expect(Object.fromEntries(fake.roles)).toEqual({
      'info@heisreal.today': 'Admin',
      'joel@heisreal.today': 'Admin',
    });
    const list = await call('GET', '');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({
        email: 'info@heisreal.today',
        role: 'Admin',
        addedBy: null,
        baseline: true,
      }),
      expect.objectContaining({
        email: 'joel@heisreal.today',
        role: 'Admin',
        addedBy: null,
        baseline: true,
      }),
    ]);
  });

  it('an Admin adds someone, changes their role and removes them: Clerk first, then the list', async () => {
    const added = await put('Ann@HeIsReal.today', 'Moderator');
    expect(added).toEqual({
      status: 200,
      body: { id: 'ann@heisreal.today', version: null },
    });
    expect(fake.roles.get('ann@heisreal.today')).toBe('Moderator');
    const ann = (await call('GET', '')).body.data.find(
      (m: { email: string }) => m.email === 'ann@heisreal.today',
    );
    expect(ann).toMatchObject({
      role: 'Moderator',
      addedBy: 'joel@heisreal.today',
      baseline: false,
    });

    expect((await put('ann@heisreal.today', 'Admin')).status).toBe(200);
    expect(fake.roles.get('ann@heisreal.today')).toBe('Admin');
    expect(await table()).toContainEqual({
      email: 'ann@heisreal.today',
      role: 'Admin',
    });

    expect((await remove('ann@heisreal.today')).status).toBe(204);
    expect(fake.roles.get('ann@heisreal.today')).toBe(null);
    expect((await table()).map((r) => r.email)).not.toContain(
      'ann@heisreal.today',
    );
    // Removing someone not on the list changes nothing.
    expect((await remove('ann@heisreal.today')).status).toBe(204);
  });

  it('a removal overlapping a promotion leaves Clerk saying what the list says', async () => {
    const eve = 'eve@heisreal.today';
    await put(eve, 'Moderator');
    let reached!: () => void;
    let release!: () => void;
    const atClerk = new Promise<void>((r) => (reached = r));
    fake.hold = {
      email: eve,
      role: null,
      reached,
      gate: new Promise<void>((r) => (release = r)),
    };
    // The removal has told Clerk "no role"; before it reaches the list, eve is made Admin.
    const removal = remove(eve);
    await atClerk;
    expect((await put(eve, 'Admin')).status).toBe(200);
    release();
    expect((await removal).status).toBe(204);
    expect((await table()).map((r) => r.email)).not.toContain(eve);
    expect(fake.roles.get(eve)).toBe(null);
  });

  it('fails (502) when Clerk can’t be put back as the list says after an overlap; saving again fixes it', async () => {
    const fay = 'fay@heisreal.today';
    await put(fay, 'Moderator');
    let reached!: () => void;
    let release!: () => void;
    const atClerk = new Promise<void>((r) => (reached = r));
    fake.hold = {
      email: fay,
      role: null,
      reached,
      gate: new Promise<void>((r) => (release = r)),
    };
    // The removal has told Clerk "no role"; fay is made Admin; then the removal reaches the list,
    // but Clerk fails when told again that fay has no role, so Clerk still says Admin.
    const removal = remove(fay);
    await atClerk;
    expect((await put(fay, 'Admin')).status).toBe(200);
    fake.failing = true;
    release();
    try {
      const res = await removal;
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('clerk_unavailable');
    } finally {
      fake.failing = false;
    }
    expect((await table()).map((r) => r.email)).not.toContain(fay);
    expect(fake.roles.get(fay)).toBe('Admin');
    // The Admin's retry puts Clerk in step with the list.
    expect((await remove(fay)).status).toBe(204);
    expect(fake.roles.get(fay)).toBe(null);
  });

  it('fails (502) when the list keeps changing while Clerk is put back; saving again fixes it', async () => {
    const gus = 'gus@heisreal.today';
    await put(gus, 'Moderator');
    // From the second Clerk call on (the putting back), another change moves gus's row each time.
    let calls = 0;
    fake.beforeSet = async (email) => {
      if (email !== gus || ++calls < 2) return;
      await migrator.query(
        `UPDATE type::record('staffMember', $email) SET role = IF role = 'Admin' { 'Moderator' } ELSE { 'Admin' } RETURN NONE`,
        { email: gus },
      );
    };
    try {
      const res = await put(gus, 'Admin');
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('clerk_unavailable');
    } finally {
      fake.beforeSet = null;
    }
    const row = (await table()).find((r) => r.email === gus);
    expect(fake.roles.get(gus)).not.toBe(row?.role);
    expect((await put(gus, 'Admin')).status).toBe(200);
    expect(fake.roles.get(gus)).toBe('Admin');
    expect(await table()).toContainEqual({ email: gus, role: 'Admin' });
    expect((await remove(gus)).status).toBe(204);
  });

  it('takes only @heisreal.today emails and the two staff roles (G7)', async () => {
    for (const [email, role] of [
      ['ann@example.com', 'Moderator'],
      ['ann@heisreal.today.example.com', 'Moderator'],
      ['ann@heisreal.today', 'SuperAdmin'],
      ['ann@heisreal.today', 'User'],
    ]) {
      const res = await put(email, role);
      expect(res.status, `${email} ${role}`).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    expect(fake.roles.has('ann@example.com')).toBe(false);
  });

  it('never removes or demotes the last Admin, and leaves Clerk as it was', async () => {
    expect((await remove('info@heisreal.today')).status).toBe(204);
    for (const res of [
      await remove('joel@heisreal.today'),
      await put('joel@heisreal.today', 'Moderator'),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_admin');
    }
    expect(fake.roles.get('joel@heisreal.today')).toBe('Admin');
    expect(await table()).toEqual([
      { email: 'joel@heisreal.today', role: 'Admin' },
    ]);
  });

  it('puts a removed baseline admin back on the next start, touching nobody else', async () => {
    await put('bob@heisreal.today', 'Moderator');
    await baseline.onApplicationBootstrap();
    await baseline.done;
    expect(fake.roles.get('info@heisreal.today')).toBe('Admin');
    expect(await table()).toEqual([
      { email: 'bob@heisreal.today', role: 'Moderator' },
      { email: 'info@heisreal.today', role: 'Admin' },
      { email: 'joel@heisreal.today', role: 'Admin' },
    ]);
  });

  it('retries the baseline step when Clerk can’t be put back as the list says', async () => {
    const info = 'info@heisreal.today';
    expect((await remove(info)).status).toBe(204);
    // Clerk takes the change, then fails once when told again (the putting back).
    let calls = 0;
    fake.beforeSet = async (email) => {
      if (email === info && ++calls === 2)
        throw new Error('Clerk answered 500');
    };
    baseline.retryMs = 0;
    try {
      await baseline.onApplicationBootstrap();
      await baseline.done;
    } finally {
      fake.beforeSet = null;
      baseline.retryMs = 30_000;
    }
    // A second attempt ran: it found info already Admin on the list and put Clerk in step.
    expect(calls).toBe(3);
    expect(fake.roles.get(info)).toBe('Admin');
    expect(await table()).toContainEqual({ email: info, role: 'Admin' });
  });

  it('changes nothing when Clerk can’t make the change', async () => {
    fake.failing = true;
    try {
      const res = await put('cat@heisreal.today', 'Moderator');
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('clerk_unavailable');
    } finally {
      fake.failing = false;
    }
    expect((await table()).map((r) => r.email)).not.toContain(
      'cat@heisreal.today',
    );
  });

  it('refuses to add or change someone with no account (S-7); removing them just takes them off the list', async () => {
    const kim = 'kim@heisreal.today';
    fake.noAccount.add(kim);
    try {
      for (const role of ['Moderator', 'Admin']) {
        const res = await put(kim, role);
        expect(res.status, role).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(res.body.errors[0].message).toBe(
          'Ask them to create an account first, then add them.',
        );
      }
      expect((await table()).map((r) => r.email)).not.toContain(kim);
      // Listed while they had no account (as the baseline step does): a change is refused, a
      // removal goes through.
      await migrator.query(
        `CREATE type::record('staffMember', $email) CONTENT { email: $email, role: 'Moderator' }`,
        { email: kim },
      );
      expect((await put(kim, 'Admin')).status).toBe(400);
      // Saving the role they're already listed with is refused too: no account holds it.
      expect((await put(kim, 'Moderator')).status).toBe(400);
      expect(await table()).toContainEqual({ email: kim, role: 'Moderator' });
      expect((await remove(kim)).status).toBe(204);
      expect((await table()).map((r) => r.email)).not.toContain(kim);
    } finally {
      fake.noAccount.delete(kim);
    }
    expect(fake.roles.has(kim)).toBe(false);
  });

  it('lists a baseline admin with no account yet, and gives them the role on a start after they sign up', async () => {
    const info = 'info@heisreal.today';
    expect((await remove(info)).status).toBe(204);
    fake.roles.delete(info);
    fake.noAccount.add(info);
    try {
      await baseline.onApplicationBootstrap();
      await baseline.done;
      expect(await table()).toContainEqual({ email: info, role: 'Admin' });
      expect(fake.roles.has(info)).toBe(false);
    } finally {
      fake.noAccount.delete(info);
    }
    // They sign up; the next start sets their Clerk role.
    await baseline.onApplicationBootstrap();
    await baseline.done;
    expect(fake.roles.get(info)).toBe('Admin');
  });

  it('counts an Admin role only with a verified @heisreal.today email in the token (S-5 A)', async () => {
    for (const claims of [
      { email: 'joel@gmail.com', email_verified: true },
      { email: 'joel@heisreal.today', email_verified: false },
      { email: undefined, email_verified: undefined },
    ]) {
      const who = {
        authorization: `Bearer ${clerk.token('user_admin', { role: 'Admin', ...claims })}`,
      };
      const res = await call('GET', '', who);
      expect(res.status, JSON.stringify(claims)).toBe(403);
      expect(res.body.code).toBe('role_required');
      expect((await put('dan@heisreal.today', 'Admin', who)).status).toBe(403);
    }
    expect(fake.roles.has('dan@heisreal.today')).toBe(false);
    expect((await call('GET', '', admin())).status).toBe(200);
  });

  it('is for Admins only (G24): a Moderator or User gets 403 everywhere', async () => {
    for (const who of [
      as('user_mod', 'Moderator', 'mod@heisreal.today'),
      as('user_mod', 'User'),
    ]) {
      expect((await call('GET', '', who)).status).toBe(403);
      expect((await put('dan@heisreal.today', 'Admin', who)).status).toBe(403);
      expect((await remove('bob@heisreal.today', who)).status).toBe(403);
    }
    expect(fake.roles.has('dan@heisreal.today')).toBe(false);
  });
});
