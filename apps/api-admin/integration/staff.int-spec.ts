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

/** Clerk as api-admin sees it: each email's role (Clerk is never called in tests). */
class FakeClerk implements StaffClerk {
  readonly enabled = true;
  roles = new Map<string, StaffRole | null>();
  failing = false;
  async setRole(email: string, role: StaffRole | null) {
    if (this.failing) throw new Error('Clerk answered 500');
    this.roles.set(email, role);
    return { kind: 'users' as const, count: 1 };
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
