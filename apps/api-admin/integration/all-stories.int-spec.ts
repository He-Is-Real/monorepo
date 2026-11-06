import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  buildWorld,
  createPeople,
  draft,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';

/**
 * R15 (Joel, 2026-11-05): super admins' read-only view of every story, through api-admin's real
 * AppModule on its own login. Every id its list gives out opens the story and pages on (Codex,
 * B1 round 1: dev-seed's `seed_v01` ids answered 404 and their cursors 400). Every answer is
 * checked against api-admin.yaml.
 */
describe('every story, for super admins (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let app: NestExpressApplication;
  let url: string;

  async function get(path: string) {
    const res = await fetch(`${url}${path}`, {
      headers: {
        authorization: `Bearer ${clerk.token('user_super', { role: 'SuperAdmin' })}`,
      },
    });
    expect(await contract.check('GET', res), path).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    const { ann } = await buildWorld(t);
    await createPeople(t, { super: 'user_super' });
    // Ids like dev-seed's, beside the world's own words.
    await draft(ann, 'seed_v01');
    await draft(ann, 'seed-v02');
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

  it('pages through every story one at a time, and opens each id the list gives out', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await get(
        `/v1/admin/stories?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.data.map((s: { id: string }) => s.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect([...seen].sort()).toEqual(
      [
        'ann_draft',
        'ann_pending',
        'bob_draft',
        'bob_live',
        'bob_pending',
        'seed-v02',
        'seed_v01',
      ].sort(),
    );
    for (const id of seen) {
      const one = await get(`/v1/admin/stories/${id}`);
      expect([one.status, one.body.id]).toEqual([200, id]);
    }
  });
});
