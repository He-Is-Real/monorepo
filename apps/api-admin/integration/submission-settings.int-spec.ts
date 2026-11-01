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

/**
 * The submission limits (W3, D94, D112, D113) through api-admin's real AppModule on its own
 * login (D13) and a real SurrealDB, as /admin/limits calls them: read them with their version,
 * save the whole set at that version (If-Match), and the audit row the database writes. Every
 * answer is checked against api-admin.yaml.
 */
describe('submission settings (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let url: string;

  const DEFAULTS = {
    storyTextMin: 200,
    storyTextMax: 10_000,
    themesMin: 1,
    themesMax: 5,
    openDraftsMax: 3,
    submissionsPer7Days: 1,
    uploadRequestsPerHour: 10,
    uploadsPer7Days: 5,
    videoMaxBytes: 4_294_967_296,
    audioMaxBytes: 524_288_000,
    mediaMaxSeconds: 900,
  };
  const as = (clerkUserId: string, role = 'Admin') => ({
    authorization: `Bearer ${clerk.token(clerkUserId, { role })}`,
  });
  const admin = () => as('user_admin');

  async function read(who: Record<string, string> = admin()) {
    const res = await fetch(`${url}/v1/admin/submission-settings`, {
      headers: who,
    });
    expect(await contract.check('GET', res)).toEqual([]);
    return res;
  }
  async function save(
    body: unknown,
    ifMatch: string | null,
    who: Record<string, string> = admin(),
  ) {
    const res = await fetch(`${url}/v1/admin/submission-settings`, {
      method: 'PUT',
      headers: {
        ...who,
        'content-type': 'application/json',
        ...(ifMatch === null ? {} : { 'if-match': ifMatch }),
      },
      body: JSON.stringify(body),
    });
    expect(await contract.check('PUT', res)).toEqual([]);
    return res;
  }
  const problem = async (res: Response) =>
    (await res.json()) as { code: string; errors?: { pointer: string }[] };
  const stored = () =>
    rows<Record<string, unknown>>(
      migrator,
      `SELECT * OMIT id, updatedAt, changedBy, changedByRole FROM ONLY submissionSettings:current`,
    ).then(([r]) => r);
  const audits = () =>
    rows<Record<string, unknown>>(
      migrator,
      `SELECT service, actorRole, record::id(actor) AS actor, createdAt FROM auditLog
       WHERE action = 'UpdateSubmissionSettings' AND actor != NONE ORDER BY createdAt`,
    ).then((r) => r.map(({ createdAt: _c, ...rest }) => rest));

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    await createPeople(t, { admin: 'user_admin', moderator: 'user_moderator' });
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
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    useBodyParser(app); // as main.ts
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('an admin reads the limits at version 1 and saves new ones at that version; the database audits it', async () => {
    const first = await read();
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('"1"');
    const body = (await first.json()) as {
      version: number;
      changedBy: string | null;
      settings: typeof DEFAULTS;
      bounds: Record<string, { min: number; max: number }>;
    };
    expect(body).toMatchObject({ version: 1, changedBy: null });
    expect(body.settings).toEqual(DEFAULTS);
    expect(body.bounds['videoMaxBytes']).toEqual({
      min: 1_048_576,
      max: 10_737_418_240,
    });

    const next = {
      ...DEFAULTS,
      submissionsPer7Days: 2,
      videoMaxBytes: 2048 * 1_048_576,
      mediaMaxSeconds: 20 * 60,
    };
    const saved = await save(next, '"1"');
    expect(saved.status).toBe(200);
    expect(saved.headers.get('etag')).toBe('"2"');
    expect(await saved.json()).toEqual({ id: 'current', version: 2 });
    expect(await stored()).toEqual({ ...next, version: 2 });
    // In force for everyone at once: what the submit flow reads (no grandfathering).
    expect(
      await rows(
        migrator,
        `RETURN fn::settings::submission().submissionsPer7Days`,
      ),
    ).toEqual([2]);
    expect(await audits()).toEqual([
      { service: 'api-admin', actorRole: 'Admin', actor: 'admin' },
    ]);
    const again = (await (await read()).json()) as { changedBy: string };
    expect(again.changedBy).toBe('admin');
  });

  it('refuses limits out of bounds or a minimum over its maximum, field by field, writing nothing', async () => {
    const before = await stored();
    const cases: [Record<string, unknown>, string][] = [
      [
        { ...DEFAULTS, storyTextMin: 5000, storyTextMax: 4000 },
        '/storyTextMin',
      ],
      [{ ...DEFAULTS, storyTextMax: 50_001 }, '/storyTextMax'],
      [{ ...DEFAULTS, openDraftsMax: 0 }, '/openDraftsMax'],
      [{ ...DEFAULTS, uploadsPer7Days: -1 }, '/uploadsPer7Days'],
      [{ ...DEFAULTS, submissionsPer7Days: 1.5 }, '/submissionsPer7Days'],
      [{ ...DEFAULTS, videoMaxBytes: 10_737_418_241 }, '/videoMaxBytes'],
      [{ ...DEFAULTS, mediaMaxSeconds: 59 }, '/mediaMaxSeconds'],
      [{ ...DEFAULTS, audioMaxBytes: '500' }, '/audioMaxBytes'],
      [{ ...DEFAULTS, featured: true }, '/featured'],
    ];
    for (const [body, pointer] of cases) {
      const res = await save(body, '"2"');
      expect([pointer, res.status]).toEqual([pointer, 400]);
      const p = await problem(res);
      expect(p.code).toBe('validation_failed');
      expect(p.errors?.[0]?.pointer).toBe(pointer);
    }
    expect(await stored()).toEqual(before);
  });

  it('a stale save gets 412 and a save without If-Match 428, writing nothing', async () => {
    const before = await stored();
    const stale = await save({ ...DEFAULTS, themesMax: 6 }, '"1"');
    expect(stale.status).toBe(412);
    expect((await problem(stale)).code).toBe('stale_version');
    const bare = await save({ ...DEFAULTS, themesMax: 6 }, null);
    expect(bare.status).toBe(428);
    expect(await stored()).toEqual(before);
    expect(await audits()).toHaveLength(1);
  });

  it('two admins saving the same version at once: one is saved, the other gets 412', async () => {
    const [a, b] = await Promise.all([
      save({ ...DEFAULTS, openDraftsMax: 4 }, '"2"'),
      save({ ...DEFAULTS, openDraftsMax: 5 }, '"2"'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 412]);
    const winner = a.status === 200 ? 4 : 5;
    expect(await stored()).toMatchObject({ openDraftsMax: winner, version: 3 });
  });

  it('is for Admin and above (D1): a moderator can neither read nor save; no token is 401', async () => {
    const before = await stored();
    const moderator = as('user_moderator', 'Moderator');
    expect((await read(moderator)).status).toBe(403);
    expect((await save(DEFAULTS, '"3"', moderator)).status).toBe(403);
    expect((await read({})).status).toBe(401);
    expect((await save(DEFAULTS, '"3"', {})).status).toBe(401);
    expect(await stored()).toEqual(before);
  });
});
