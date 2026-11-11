import type { Surreal } from 'surrealdb';
import { outcome, rows, TestDatabase } from './support/harness';

/**
 * The Staff page's list, `staffMember` (S-1 to S-4, G7, G8 B; Joel 2026-11-11). Clerk holds the
 * roles; this table is the list Admins see and edit, through api-admin. The database itself
 * keeps three rules: only api-admin's login may read or write it, only @heisreal.today emails
 * (G7), and never without an Admin.
 */
describe('staffMember: the Staff page list', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;

  const add = (db: Surreal, email: string, role: string, by?: string) =>
    outcome(
      db,
      `CREATE type::record('staffMember', $email) CONTENT { email: $email, role: $role, addedBy: $by }`,
      { email, role, by },
    );
  const list = () =>
    rows<{ email: string; role: string }>(
      migrator,
      'SELECT email, role FROM staffMember ORDER BY email',
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
  });
  afterAll(() => t?.close());
  beforeEach(() => migrator.query('DELETE staffMember'));

  it('api-admin adds, lists, changes and removes staff, keeping who added them and when', async () => {
    expect(
      await add(admin, 'joel@heisreal.today', 'Admin', 'info@heisreal.today'),
    ).toMatchObject({ ok: true });
    expect(await add(admin, 'ann@heisreal.today', 'Moderator')).toMatchObject({
      ok: true,
    });
    const [row] = await rows<Record<string, unknown>>(
      admin,
      `SELECT * FROM ONLY staffMember:⟨joel@heisreal.today⟩`,
    );
    expect(row).toMatchObject({
      email: 'joel@heisreal.today',
      role: 'Admin',
      addedBy: 'info@heisreal.today',
    });
    expect(row['addedAt']).toBeTruthy();

    expect(
      await outcome(
        admin,
        `UPDATE staffMember:⟨ann@heisreal.today⟩ SET role = 'Admin'`,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await outcome(admin, `DELETE staffMember:⟨joel@heisreal.today⟩`),
    ).toMatchObject({ ok: true });
    expect(await list()).toEqual([
      { email: 'ann@heisreal.today', role: 'Admin' },
    ]);
  });

  it('takes only lower-case @heisreal.today emails, as the record id, and only the two staff roles (G7)', async () => {
    for (const [email, role] of [
      ['ann@example.com', 'Admin'],
      ['ann@heisreal.today.evil.com', 'Admin'],
      ['ann@sub.heisreal.today', 'Admin'],
      ['Ann@heisreal.today', 'Admin'],
      ['@heisreal.today', 'Admin'],
      ['ann@heisreal.today', 'SuperAdmin'],
      ['ann@heisreal.today', 'User'],
    ]) {
      expect(await add(admin, email, role), `${email} ${role}`).toMatchObject({
        ok: false,
      });
    }
    // The id and the email must be the same address.
    expect(
      await outcome(
        admin,
        `CREATE staffMember:⟨bob@heisreal.today⟩ CONTENT { email: 'ann@heisreal.today', role: 'Admin' }`,
      ),
    ).toMatchObject({ ok: false });
    expect(await list()).toEqual([]);
  });

  it('never removes or demotes the last Admin', async () => {
    await add(admin, 'joel@heisreal.today', 'Admin');
    await add(admin, 'ann@heisreal.today', 'Moderator');
    for (const sql of [
      `DELETE staffMember:⟨joel@heisreal.today⟩`,
      `UPDATE staffMember:⟨joel@heisreal.today⟩ SET role = 'Moderator'`,
      `DELETE staffMember`,
    ]) {
      const refused = await outcome(admin, sql);
      expect(refused, sql).toMatchObject({ ok: false });
      expect((refused as { error: string }).error).toContain(
        'staff:last_admin',
      );
    }
    // A Moderator can still go, and with a second Admin the first can too.
    expect(
      await outcome(admin, `DELETE staffMember:⟨ann@heisreal.today⟩`),
    ).toMatchObject({ ok: true });
    await add(admin, 'info@heisreal.today', 'Admin');
    expect(
      await outcome(
        admin,
        `UPDATE staffMember:⟨joel@heisreal.today⟩ SET role = 'Moderator'`,
      ),
    ).toMatchObject({ ok: true });
    expect(await list()).toEqual([
      { email: 'info@heisreal.today', role: 'Admin' },
      { email: 'joel@heisreal.today', role: 'Moderator' },
    ]);
  });

  it('refuses the second of two overlapping removals that would leave no Admin', async () => {
    await add(admin, 'joel@heisreal.today', 'Admin');
    await add(admin, 'info@heisreal.today', 'Admin');
    const other = await t.service('api_admin');
    // Each alone leaves one Admin; together they would leave none. A removes (uncommitted), B
    // removes the other and commits, then A commits: the shared fence makes A conflict.
    const a = await admin.beginTransaction();
    await a.query(`DELETE staffMember:⟨joel@heisreal.today⟩`).collect();
    expect(
      await outcome(other, `DELETE staffMember:⟨info@heisreal.today⟩`),
    ).toMatchObject({ ok: true });
    await expect(a.commit()).rejects.toThrow(/conflict/i);
    expect(await list()).toEqual([
      { email: 'joel@heisreal.today', role: 'Admin' },
    ]);
    await other.close();
  });

  it('is api-admin’s alone: no other service reads or writes it', async () => {
    await add(admin, 'joel@heisreal.today', 'Admin');
    for (const name of ['api_public_read', 'api_user', 'workflow'] as const) {
      const db = await t.service(name);
      expect(await rows(db, 'SELECT * FROM staffMember'), name).toEqual([]);
      await add(db, 'ann@heisreal.today', 'Admin');
      await outcome(db, `DELETE staffMember:⟨joel@heisreal.today⟩`);
      await db.close();
    }
    expect(await list()).toEqual([
      { email: 'joel@heisreal.today', role: 'Admin' },
    ]);
  });
});
