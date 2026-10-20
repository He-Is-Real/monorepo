import type { Surreal } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  outcome,
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
    // Erased people, as the nightly job would find them years later (stubs: no Clerk id).
    await run(
      migrator,
      `FOR $u IN [user:old_erased, user:edge_erased, user:recent_erased] {
         CREATE $u;
         FOR $t IN ['special_category_religious', 'publish'] {
           CREATE consent CONTENT { subject: $u, type: $t, event: 'granted',
             dpaVersion: dpaVersion:v1, mechanism: 'web_form_submission', evidenceHash: $h };
         };
       };
       -- Only a system user (the migrator) may supply a historical erasure date.
       UPDATE user:old_erased SET gdprDeletedAt = time::now() - 2200d;
       UPDATE user:edge_erased SET gdprDeletedAt = time::now() - 2191d;
       UPDATE user:recent_erased SET gdprDeletedAt = time::now() - 365d;`,
      { h: 'c'.repeat(64) },
    );
  });
  afterAll(() => t?.close());

  it('no service or person can delete consent, however old', async () => {
    for (const name of SERVICES) {
      expect(
        await rows(
          await t.service(name),
          'DELETE consent WHERE subject = user:old_erased RETURN BEFORE',
        ),
      ).toEqual([]);
    }
    expect(
      await rows(await t.person('user_live'), 'DELETE consent RETURN BEFORE'),
    ).toEqual([]);
    expect(await consentOf('old_erased')).toHaveLength(2);
    expect(await consentOf('live')).toHaveLength(1);
  });

  it.each([
    ['a live subject', 'live'],
    ['a subject erased a year ago', 'recent_erased'],
    ['a subject erased 2191 days ago (not yet 6 years)', 'edge_erased'],
  ])('the migrator cannot prune %s', async (_, user) => {
    const before = await consentOf(user);
    expect(
      await outcome(
        migrator,
        `DELETE consent WHERE subject = type::record('user', $user)`,
        { user },
      ),
    ).toEqual({ ok: false, error: expect.stringContaining('append-only') });
    expect(await consentOf(user)).toEqual(before);
  });

  it('the nightly job (as migrator) prunes only subjects erased more than 6 years ago', async () => {
    await run(migrator, NIGHTLY_CONSENT_PRUNE);
    expect(await consentOf('old_erased')).toEqual([]);
    expect(await consentOf('edge_erased')).toHaveLength(2);
    expect(await consentOf('recent_erased')).toHaveLength(2);
    expect(await consentOf('live')).toHaveLength(1);
  });

  it('updates stay refused even for the migrator', async () => {
    expect(
      await outcome(
        migrator,
        `UPDATE consent SET event = 'withdrawn' WHERE subject = user:edge_erased`,
      ),
    ).toEqual({ ok: false, error: expect.stringContaining('append-only') });
  });

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
});
