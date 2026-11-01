import type { Surreal } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  publishDpa,
  rows,
  run,
  SERVICES,
  TestDatabase,
} from './support/harness';

/**
 * D38 retention (review round 2, P3): consent rows are kept until 6 years after the subject's
 * erasure, then deleted by a nightly job running as the migrator. The ledger stays append-only
 * for everything else. Audit rows: only the migrator can delete them (no service or person).
 */
const NIGHTLY_CONSENT_PRUNE = `DELETE consent
  WHERE subject.gdprDeletedAt != NONE AND subject.gdprDeletedAt < time::now() - 2192d`;

describe('retention pruning (D38)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  const consentOf = (user: string) =>
    rows(
      migrator,
      `SELECT VALUE id FROM consent WHERE subject = type::record('user', $user)`,
      {
        user,
      },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    await publishDpa(t, 'v1');
    await createPeople(t, { live: 'user_live' });
    await consentEvent(await t.person('user_live'), 'publish', 'granted');
  });
  afterAll(() => t?.close());

  it('audit rows: the migrator can prune them; no service or person can', async () => {
    await run(
      await t.service('api_admin'),
      `CREATE auditLog:old CONTENT { service: 'api-admin', action: 'PublishDpa', entity: dpaVersion:v1 }`,
    );
    for (const name of SERVICES) {
      expect(
        await rows(await t.service(name), 'DELETE auditLog:old RETURN BEFORE'),
      ).toEqual([]);
    }
    expect(
      await rows(
        await t.person('user_live'),
        'DELETE auditLog:old RETURN BEFORE',
      ),
    ).toEqual([]);
    expect(
      await rows(migrator, 'SELECT VALUE id FROM auditLog:old'),
    ).toHaveLength(1);
    await run(migrator, 'DELETE auditLog:old');
    expect(await rows(migrator, 'SELECT VALUE id FROM auditLog:old')).toEqual(
      [],
    );
  });

  it.each(['api_user', 'api_admin'] as const)(
    'a backdated erasure by %s stores the server time, so nothing becomes prunable (round 3, P2)',
    async (name) => {
      const p = `backdate_${name}`;
      await createPeople(t, { [p]: `user_${p}` });
      await consentEvent(await t.person(`user_${p}`), 'publish', 'granted');
      // Codex's reproduction: the full erasure, with a client-supplied date 2200 days ago.
      await run(
        await t.service('api_user'),
        `UPDATE type::record('user', $p) SET gdprDeletedAt = time::now() - 2200d, clerkUserId = NONE`,
        { p },
      );
      const [stored] = await rows<string>(
        migrator,
        `SELECT VALUE gdprDeletedAt FROM type::record('user', $p)`,
        { p },
      );
      expect(Date.parse(stored)).toBeGreaterThan(Date.now() - 60_000);
      // And it can't be re-dated afterwards, by this service or the other.
      await run(
        await t.service(name),
        `UPDATE type::record('user', $p) SET gdprDeletedAt = time::now() - 2200d`,
        { p },
      );
      expect(
        await rows(
          migrator,
          `SELECT VALUE gdprDeletedAt FROM type::record('user', $p)`,
          { p },
        ),
      ).toEqual([stored]);
      await run(migrator, NIGHTLY_CONSENT_PRUNE);
      expect(await consentOf(p)).toHaveLength(1);
    },
  );

  it('api_admin stamping a Clerk-free legacy user’s FIRST gdprDeletedAt stores the server time (round 4)', async () => {
    await run(migrator, 'CREATE user:legacy_first'); // D22 legacy person: no Clerk id
    await run(
      await t.service('api_admin'),
      `UPDATE user:legacy_first SET gdprDeletedAt = time::now() - 2200d`,
    );
    const [stored] = await rows<string>(
      migrator,
      'SELECT VALUE gdprDeletedAt FROM user:legacy_first',
    );
    expect(Date.parse(stored)).toBeGreaterThan(Date.now() - 60_000);
  });
});
