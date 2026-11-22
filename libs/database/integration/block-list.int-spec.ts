import type { Surreal } from 'surrealdb';
import {
  agreeAll,
  createPeople,
  outcome,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from './support/harness';
import { buildWorld, draft, ERASE, step, submit } from './support/world';

/**
 * The block list (G21 D, Joel 2026-11-11; m3-plan-and-m2-extras.html, "Block list"): blocked
 * emails and IP addresses, in plain text, that only Admins (api-admin's login) read and change,
 * kept until an Admin removes them; and the IP address each story is sent from
 * (`storyStatusLog.senderIp`), readable by api-admin and the person who sent it, and cleared by the nightly housekeeping
 * after 30 days. api-user may ask about one email or address at a time ($blockCheck), never
 * list them. Also the email each story is sent with (`storyStatusLog.senderEmail`, EM-1 B, Joel
 * 2026-11-17), kept as long as the entry, and the email of the Moderator or Admin who made each of
 * their entries (`storyStatusLog.staffEmail`), which only api-admin reads.
 */
describe('block list', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let ann: Surreal;

  const addEmail = (db: Surreal, email: string, by?: string) =>
    outcome(
      db,
      `CREATE type::record('blockedEmail', $email) CONTENT { email: $email, addedBy: $by }`,
      { email, by },
    );
  const addIp = (db: Surreal, ip: string, by?: string) =>
    outcome(
      db,
      `CREATE type::record('blockedIp', $ip) CONTENT { ip: $ip, addedBy: $by }`,
      { ip, by },
    );
  const allBlocks = async () => [
    ...(await rows<string>(
      migrator,
      'SELECT VALUE email FROM blockedEmail ORDER BY email',
    )),
    ...(await rows<string>(
      migrator,
      'SELECT VALUE ip FROM blockedIp ORDER BY ip',
    )),
  ];

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    ({ admin, ann } = await buildWorld(t));
    apiUser = await t.service('api_user');
  });
  afterAll(() => t?.close());
  beforeEach(() => migrator.query('DELETE blockedEmail; DELETE blockedIp;'));

  it('api-admin adds, lists and removes blocked emails and IP addresses, keeping who added each and when', async () => {
    const by = 'joel@heisreal.today';
    expect(await addEmail(admin, 'spam@example.com', by)).toMatchObject({
      ok: true,
    });
    expect(await addIp(admin, '203.0.113.7', by)).toMatchObject({ ok: true });
    expect(await addIp(admin, '2001:db8::1', by)).toMatchObject({ ok: true });
    const [email] = await rows<Record<string, unknown>>(
      admin,
      'SELECT * FROM blockedEmail',
    );
    expect(email).toMatchObject({ email: 'spam@example.com', addedBy: by });
    expect(email['addedAt']).toBeTruthy();
    expect(
      await rows(admin, 'SELECT VALUE ip FROM blockedIp ORDER BY ip'),
    ).toEqual(['2001:db8::1', '203.0.113.7']);

    expect(
      await outcome(admin, `DELETE type::record('blockedIp', '2001:db8::1')`),
    ).toMatchObject({ ok: true });
    expect(
      await outcome(
        admin,
        `DELETE type::record('blockedEmail', 'spam@example.com')`,
      ),
    ).toMatchObject({ ok: true });
    expect(await allBlocks()).toEqual(['203.0.113.7']);
  });

  it('takes only lower-case, valid values, as the record id, and always names the admin', async () => {
    const by = 'joel@heisreal.today';
    for (const email of ['Spam@example.com', 'not-an-email', '']) {
      expect(await addEmail(admin, email, by), email).toMatchObject({
        ok: false,
      });
    }
    expect(
      await outcome(
        admin,
        `CREATE blockedEmail:⟨a@example.com⟩ CONTENT { email: 'b@example.com', addedBy: $by }`,
        { by },
      ),
    ).toMatchObject({ ok: false });
    for (const ip of ['999.1.1.1', '2001:DB8::1', 'example.com', '']) {
      expect(await addIp(admin, ip, by), ip).toMatchObject({ ok: false });
    }
    expect(await addEmail(admin, 'spam@example.com')).toMatchObject({
      ok: false,
    });
    expect(await addIp(admin, '203.0.113.7')).toMatchObject({ ok: false });
    expect(await allBlocks()).toEqual([]);
  });

  it('keeps an optional note that only api-admin reads and changes; the value, adder and date stay', async () => {
    const by = 'joel@heisreal.today';
    expect(
      await outcome(
        admin,
        `CREATE blockedEmail:⟨spam@example.com⟩ CONTENT { email: 'spam@example.com', addedBy: $by, note: 'Advert stories' }`,
        { by },
      ),
    ).toMatchObject({ ok: true });
    // Blank is allowed (BN-2: a fast ban wave, notes later).
    expect(await addIp(admin, '203.0.113.7', by)).toMatchObject({ ok: true });
    // api-admin changes the note, and only the note.
    expect(
      await outcome(
        admin,
        `UPDATE blockedIp:⟨203.0.113.7⟩ SET note = 'Same sender again'`,
      ),
    ).toMatchObject({ ok: true });
    for (const change of [
      `addedBy = 'info@heisreal.today'`,
      `addedAt = d'2020-01-01T00:00:00Z'`,
      `email = 'other@example.com'`,
    ]) {
      await outcome(
        admin,
        `UPDATE blockedEmail:⟨spam@example.com⟩ SET ${change}`,
      );
    }
    // Over 500 characters, blank or untrimmed is refused.
    for (const note of ['x'.repeat(501), '', ' padded ']) {
      expect(
        await outcome(
          admin,
          `UPDATE blockedEmail:⟨spam@example.com⟩ SET note = $note`,
          { note },
        ),
        JSON.stringify(note),
      ).toMatchObject({ ok: false });
    }
    expect(
      await outcome(
        admin,
        `UPDATE blockedEmail:⟨spam@example.com⟩ SET note = $note`,
        { note: 'y'.repeat(500) },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await rows(migrator, 'SELECT email, addedBy, note FROM blockedEmail'),
    ).toEqual([
      { email: 'spam@example.com', addedBy: by, note: 'y'.repeat(500) },
    ]);
    expect(await rows(admin, 'SELECT VALUE note FROM blockedIp')).toEqual([
      'Same sender again',
    ]);
    // api-user's one-row check still answers, but never sees the note, nor changes it.
    const seen = await rows<Record<string, unknown>>(
      apiUser,
      'SELECT * FROM blockedIp',
      { blockCheck: '203.0.113.7' },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]['note']).toBeUndefined();
    await outcome(apiUser, `UPDATE blockedIp SET note = 'x'`, {
      blockCheck: '203.0.113.7',
    });
    expect(await rows(admin, 'SELECT VALUE note FROM blockedIp')).toEqual([
      'Same sender again',
    ]);
  });

  it('no one else reads or changes it: people, api-user (beyond one named value), workflow, housekeeping, the public', async () => {
    await addEmail(admin, 'spam@example.com', 'joel@heisreal.today');
    await addIp(admin, '203.0.113.7', 'joel@heisreal.today');
    const others: [string, Surreal][] = [
      ['person', ann],
      ['api_user', apiUser],
      ['workflow', await t.service('workflow')],
      ['housekeeping', await t.service('housekeeping')],
      ['api_public_read', await t.service('api_public_read')],
    ];
    for (const [name, db] of others) {
      expect(
        await rows(db, 'SELECT * FROM blockedEmail'),
        `${name} lists emails`,
      ).toEqual([]);
      expect(
        await rows(db, 'SELECT * FROM blockedIp'),
        `${name} lists IPs`,
      ).toEqual([]);
      await outcome(
        db,
        `CREATE blockedEmail:⟨x@example.com⟩ SET email = 'x@example.com', addedBy = 'x@example.com';
         CREATE blockedIp:⟨198.51.100.1⟩ SET ip = '198.51.100.1', addedBy = 'x@example.com';
         UPDATE blockedEmail SET note = 'x'; UPDATE blockedIp SET note = 'x';
         DELETE blockedEmail; DELETE blockedIp;`,
      );
    }
    expect(await allBlocks()).toEqual(['spam@example.com', '203.0.113.7']);
    expect(await rows(migrator, 'SELECT VALUE note FROM blockedEmail')).toEqual(
      [undefined],
    );
  });

  it('api-user can ask about exactly one email or address it names, and see nothing else', async () => {
    await addEmail(admin, 'spam@example.com', 'joel@heisreal.today');
    await addEmail(admin, 'other@example.com', 'joel@heisreal.today');
    await addIp(admin, '203.0.113.7', 'joel@heisreal.today');
    const ask = (table: string, value: string) =>
      rows(apiUser, `SELECT VALUE id FROM ${table}`, { blockCheck: value });
    expect(await ask('blockedEmail', 'spam@example.com')).toHaveLength(1);
    expect(await ask('blockedEmail', 'fine@example.com')).toEqual([]);
    expect(await ask('blockedIp', '203.0.113.7')).toHaveLength(1);
    expect(await ask('blockedIp', '203.0.113.8')).toEqual([]);
    // A person's session gets nothing even naming the value.
    expect(
      await rows(ann, 'SELECT VALUE id FROM blockedEmail', {
        blockCheck: 'spam@example.com',
      }),
    ).toEqual([]);
  });

  it('stays after the person deletes their account', async () => {
    await createAndErase('user_gone', 'gone');
    await addEmail(admin, 'gone@example.com', 'joel@heisreal.today');
    await createAndErase('user_gone2', 'gone2');
    expect(await allBlocks()).toEqual(['gone@example.com']);
  });

  async function createAndErase(clerkUserId: string, id: string) {
    await run(
      apiUser,
      `CREATE type::record('user', $id) SET clerkUserId = $c`,
      {
        id,
        c: clerkUserId,
      },
    );
    await run(apiUser, ERASE, { clerkUserId, reason: 'self' });
  }

  describe("a story's sender IP address (storyStatusLog.senderIp)", () => {
    const sentWithIp = (db: Surreal, id: string, senderIp: unknown) =>
      outcome(
        db,
        `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'sent', senderIp: $senderIp }`,
        { id, senderIp },
      );
    const ipsOf = (id: string) =>
      rows(
        migrator,
        `SELECT VALUE senderIp FROM storyStatusLog WHERE story = type::record('story', $id) AND senderIp != NONE`,
        { id },
      );

    it("is kept on the person's own sent entry, and only api-admin and that person read it", async () => {
      await draft(ann, 'ann_ip');
      expect(await sentWithIp(ann, 'ann_ip', '203.0.113.7')).toMatchObject({
        ok: true,
      });
      expect(await ipsOf('ann_ip')).toEqual(['203.0.113.7']);
      expect(
        await rows(
          admin,
          `SELECT VALUE senderIp FROM storyStatusLog WHERE story = story:ann_ip`,
        ),
      ).toEqual(['203.0.113.7']);
      // The person who sent it, in their own session (their "Download my data" export, BL-4).
      expect(
        await rows(
          ann,
          `SELECT VALUE senderIp FROM storyStatusLog WHERE story = story:ann_ip`,
        ),
      ).toEqual(['203.0.113.7']);
      for (const [name, db] of [
        ['someone else', await t.person('user_bob')],
        ['api_user', apiUser],
        ['workflow', await t.service('workflow')],
      ] as const) {
        const read = await rows<Record<string, unknown>>(
          db,
          `SELECT * FROM storyStatusLog WHERE story = story:ann_ip`,
        );
        expect(
          read.some((r) => r['senderIp'] !== undefined),
          name,
        ).toBe(false);
      }
    });

    it("is dropped on anyone else's entry, and refused when it isn't a lower-case IP address", async () => {
      await draft(ann, 'ann_ip2');
      expect(await sentWithIp(ann, 'ann_ip2', 'not-an-ip')).toMatchObject({
        ok: false,
      });
      expect(await sentWithIp(ann, 'ann_ip2', '2001:DB8::1')).toMatchObject({
        ok: false,
      });
      await submit(ann, 'ann_ip2');
      // A moderator's entry can't carry one.
      await run(
        admin,
        `CREATE storyStatusLog CONTENT { story: story:ann_ip2, action: 'changesRequested', comment: 'x', by: user:moderator, staffEmail: 'moderator@heisreal.today', senderIp: '198.51.100.1' }`,
      );
      expect(await ipsOf('ann_ip2')).toEqual([]);
    });

    describe('the nightly housekeeping', () => {
      let housekeeping: Surreal;
      const DAY = 24 * 60 * 60 * 1000;
      const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

      /** A story sent `days` ago from `ip`, as dev-seed's history would load it. */
      async function sentDaysAgo(id: string, days: number, ip: string) {
        await draft(ann, id);
        await run(
          migrator,
          `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'sent',
             actor: 'person', at: $at, senderIp: $ip }`,
          { id, at: daysAgo(days), ip },
        );
      }
      const clear = () =>
        outcome(
          housekeeping,
          `UPDATE storyStatusLog SET senderIp = NONE
             WHERE at < fn::story::sender_ips_expire_before() RETURN NONE`,
        );

      beforeAll(async () => {
        housekeeping = await t.service('housekeeping');
      });

      it('clears it 30 days after the entry, and only then', async () => {
        await sentDaysAgo('ann_old', 31, '203.0.113.1');
        await sentDaysAgo('ann_recent', 29, '203.0.113.2');
        expect(await clear()).toMatchObject({ ok: true });
        expect(await ipsOf('ann_old')).toEqual([]);
        expect(await ipsOf('ann_recent')).toEqual(['203.0.113.2']);
        // The entry itself is unchanged.
        const [entry] = await rows<Record<string, unknown>>(
          migrator,
          `SELECT status, actor, at FROM storyStatusLog WHERE story = story:ann_old`,
        );
        expect(entry).toMatchObject({ status: 'pending', actor: 'person' });
        expect(new Date(entry['at'] as string).getTime()).toBeLessThan(
          daysAgo(30).getTime(),
        );
      });

      it('sees only old entries still holding an address, and never the address or the words', async () => {
        await sentDaysAgo('ann_old2', 40, '203.0.113.3');
        const seen = await rows<Record<string, unknown>>(
          housekeeping,
          `SELECT * FROM storyStatusLog WHERE status = 'pending'`,
        );
        expect(seen.map((r) => r['story'])).toEqual(['story:ann_old2']);
        expect(seen[0]['senderIp']).toBeUndefined();
        expect(seen[0]['comment']).toBeUndefined();
      });

      it('changes nothing else, and nobody else clears or changes an entry', async () => {
        await sentDaysAgo('ann_old3', 40, '203.0.113.4');
        // Nobody else clears it.
        for (const db of [admin, apiUser, ann]) {
          await outcome(
            db,
            `UPDATE storyStatusLog SET senderIp = NONE WHERE story = story:ann_old3`,
          );
        }
        expect(await ipsOf('ann_old3')).toEqual(['203.0.113.4']);
        // Housekeeping can only clear it: another address written there is dropped.
        await outcome(
          housekeeping,
          `UPDATE storyStatusLog SET senderIp = '198.51.100.9' WHERE story = story:ann_old3`,
        );
        expect(await ipsOf('ann_old3')).toEqual([]);
        await sentDaysAgo('ann_old5', 40, '203.0.113.6');
        // Clearing it together with any other change is refused whole: the entry's other fields
        // are read-only.
        for (const change of [
          `action = 'editStarted', senderIp = NONE`,
          `comment = 'x', senderIp = NONE`,
        ]) {
          await outcome(
            housekeeping,
            `UPDATE storyStatusLog SET ${change} WHERE story = story:ann_old5`,
          );
        }
        expect(
          await rows(
            migrator,
            `SELECT status, comment FROM storyStatusLog WHERE story = story:ann_old5`,
          ),
        ).toEqual([{ status: 'pending' }]);
        expect(await ipsOf('ann_old5')).toEqual(['203.0.113.6']);
        await sentDaysAgo('ann_old4', 40, '203.0.113.5');
        // System users are held to the append-only rule too, but for clearing the address.
        expect(
          await outcome(
            migrator,
            `UPDATE storyStatusLog SET comment = 'x' WHERE story = story:ann_old4`,
          ),
        ).toMatchObject({ ok: false });
        expect(
          await outcome(
            migrator,
            `UPDATE storyStatusLog SET senderIp = NONE WHERE story = story:ann_old4`,
          ),
        ).toMatchObject({ ok: true });
        expect(await ipsOf('ann_old4')).toEqual([]);
      });
    });
  });
  describe("the email a story is sent with (senderEmail) and the staff member's email (staffEmail)", () => {
    const sentWith = (
      db: Surreal,
      id: string,
      extra: Record<string, unknown>,
    ) =>
      outcome(
        db,
        `CREATE storyStatusLog CONTENT object::extend({ story: type::record('story', $id), action: 'sent' }, $extra)`,
        { id, extra },
      );
    const fieldOf = (db: Surreal, field: string, id: string) =>
      rows(
        db,
        `SELECT VALUE ${field} FROM storyStatusLog WHERE story = type::record('story', $id) AND ${field} != NONE`,
        { id },
      );

    it("keeps the sender's email on the person's own sent entry; only api-admin and that person read it", async () => {
      await draft(ann, 'ann_em');
      for (const bad of ['Ann@Example.com', 'not-an-email']) {
        expect(
          await sentWith(ann, 'ann_em', { senderEmail: bad }),
          bad,
        ).toMatchObject({ ok: false });
      }
      expect(
        await sentWith(ann, 'ann_em', { senderEmail: 'ann@example.com' }),
      ).toMatchObject({ ok: true });
      expect(await fieldOf(migrator, 'senderEmail', 'ann_em')).toEqual([
        'ann@example.com',
      ]);
      expect(await fieldOf(admin, 'senderEmail', 'ann_em')).toEqual([
        'ann@example.com',
      ]);
      expect(await fieldOf(ann, 'senderEmail', 'ann_em')).toEqual([
        'ann@example.com',
      ]);
      for (const [name, db] of [
        ['someone else', await t.person('user_bob')],
        ['api_user', apiUser],
        ['workflow', await t.service('workflow')],
        ['housekeeping', await t.service('housekeeping')],
      ] as const) {
        const read = await rows<Record<string, unknown>>(
          db,
          `SELECT * FROM storyStatusLog WHERE story = story:ann_em`,
        );
        expect(
          read.some((r) => r['senderEmail'] !== undefined),
          name,
        ).toBe(false);
      }
      // Nobody changes or clears it: it stays as long as the entry.
      for (const db of [admin, ann, await t.service('housekeeping')]) {
        await outcome(
          db,
          `UPDATE storyStatusLog SET senderEmail = NONE WHERE story = story:ann_em`,
        );
      }
      expect(await fieldOf(migrator, 'senderEmail', 'ann_em')).toEqual([
        'ann@example.com',
      ]);
    });

    it("is dropped on any other entry: a person's Edit and a moderator's decision", async () => {
      await draft(ann, 'ann_em2');
      await submit(ann, 'ann_em2');
      await step(admin, 'ann_em2', 'changesRequested', {
        senderEmail: 'mod@example.com',
      });
      await draft(ann, 'ann_em3');
      await submit(ann, 'ann_em3');
      await step(ann, 'ann_em3', 'editStarted', {
        senderEmail: 'ann@example.com',
      });
      expect(await fieldOf(migrator, 'senderEmail', 'ann_em2')).toEqual([]);
      expect(await fieldOf(migrator, 'senderEmail', 'ann_em3')).toEqual([]);
    });

    it('is not cleared by the nightly housekeeping, which still clears the IP address', async () => {
      await draft(ann, 'ann_em_old');
      await run(
        migrator,
        `CREATE storyStatusLog CONTENT { story: story:ann_em_old, action: 'sent', actor: 'person',
           at: time::now() - 31d, senderIp: '203.0.113.40', senderEmail: 'ann@example.com' }`,
      );
      const housekeeping = await t.service('housekeeping');
      expect(
        await outcome(
          housekeeping,
          `UPDATE storyStatusLog SET senderIp = NONE
             WHERE at < fn::story::sender_ips_expire_before() RETURN NONE`,
        ),
      ).toMatchObject({ ok: true });
      expect(await fieldOf(migrator, 'senderIp', 'ann_em_old')).toEqual([]);
      expect(await fieldOf(migrator, 'senderEmail', 'ann_em_old')).toEqual([
        'ann@example.com',
      ]);
    });

    it('goes with the story when it is deleted, and with the account when it is erased', async () => {
      await createPeople(t, { cara: 'user_cara' });
      await trustSubmitters(t, 'cara');
      const cara = await t.person('user_cara');
      await agreeAll(cara);
      for (const id of ['cara_a', 'cara_b']) {
        await draft(cara, id);
        await sentWith(cara, id, { senderEmail: 'cara@example.com' });
      }
      const caraEmails = () =>
        rows(
          migrator,
          `SELECT VALUE senderEmail FROM storyStatusLog WHERE senderEmail = 'cara@example.com'`,
        );
      expect(await caraEmails()).toHaveLength(2);
      await run(cara, `DELETE story:cara_a`);
      expect(await caraEmails()).toHaveLength(1);
      await run(apiUser, ERASE, {
        clerkUserId: 'user_cara',
        reason: 'account_deleted',
      });
      expect(await caraEmails()).toEqual([]);
    });

    it("names the staff member on every entry api-admin writes, and never shows it to the story's owner", async () => {
      await draft(ann, 'ann_staff');
      await submit(ann, 'ann_staff');
      // api-admin's entry without the staff member's email is refused.
      expect(
        await outcome(
          admin,
          `CREATE storyStatusLog CONTENT { story: story:ann_staff, action: 'changesRequested',
             comment: 'x', by: user:moderator }`,
        ),
      ).toMatchObject({ ok: false });
      for (const bad of ['Mod@HeIsReal.today', 'not-an-email']) {
        expect(
          await outcome(
            admin,
            `CREATE storyStatusLog CONTENT { story: story:ann_staff, action: 'changesRequested',
               comment: 'x', by: user:moderator, staffEmail: $bad }`,
            { bad },
          ),
          bad,
        ).toMatchObject({ ok: false });
      }
      await step(admin, 'ann_staff', 'changesRequested');
      expect(await fieldOf(admin, 'staffEmail', 'ann_staff')).toEqual([
        'moderator@heisreal.today',
      ]);
      // The person's own entries never carry one.
      await sentWith(ann, 'ann_staff', { staffEmail: 'ann@example.com' });
      expect(await fieldOf(migrator, 'staffEmail', 'ann_staff')).toEqual([
        'moderator@heisreal.today',
      ]);
      // Only api-admin reads it: not the owner, nor any other service.
      for (const [name, db] of [
        ['owner', ann],
        ['api_user', apiUser],
        ['workflow', await t.service('workflow')],
        ['housekeeping', await t.service('housekeeping')],
        ['api_public_read', await t.service('api_public_read')],
      ] as const) {
        const read = await rows<Record<string, unknown>>(
          db,
          `SELECT * FROM storyStatusLog WHERE story = story:ann_staff`,
        );
        expect(
          read.some((r) => r['staffEmail'] !== undefined),
          name,
        ).toBe(false);
      }
    });
  });
});
