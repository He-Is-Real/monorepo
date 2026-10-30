import { createHash } from 'node:crypto';
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
 * The legal documents (D121, D125; Joel, 2026-10-30) through api-admin's real AppModule on its
 * own login (D13) and a real SurrealDB 3.2.4, as /admin/legal calls them: publish (the first
 * version, then the next, on the version edited), the versions list. A version is the Markdown
 * the site renders, numbered by the database and kept for ever. Every answer is checked against
 * api-admin.yaml.
 */
describe('legal documents (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let url: string;

  const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');
  const as = (clerkUserId: string, role = 'Admin') => ({
    authorization: `Bearer ${clerk.token(clerkUserId, { role })}`,
  });

  async function publish(
    document: string,
    body: Record<string, unknown>,
    who: Record<string, string> = as('user_admin'),
  ) {
    const res = await fetch(
      `${url}/v1/admin/legal-documents/${document}/versions`,
      {
        method: 'POST',
        headers: { ...who, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(await contract.check('POST', res)).toEqual([]);
    return res;
  }
  const list = async (
    document: string,
    who: Record<string, string> = as('user_admin'),
  ) => {
    const res = await fetch(
      `${url}/v1/admin/legal-documents/${document}/versions`,
      { headers: who },
    );
    expect(await contract.check('GET', res)).toEqual([]);
    return res;
  };
  const code = async (res: Response) =>
    ((await res.json()) as { code: string }).code;
  const audit = () =>
    rows<Record<string, unknown>>(
      migrator,
      `SELECT action, service, actorRole, record::id(actor) AS actor,
         record::tb(entity) AS entity, createdAt FROM auditLog
       WHERE action IN ['PublishPrivacyPolicy', 'PublishTerms'] ORDER BY createdAt`,
    ).then((r) =>
      r.map((row) => {
        const rest = { ...row };
        delete rest['createdAt']; // only for the order
        return rest;
      }),
    );

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

  it('publishes the first terms of use as version 1, in force at once, audited', async () => {
    const text = '# Terms\r\n\r\nThe **first** words.\r\n';
    const res = await publish('terms', { text, basedOn: null });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ number: 1 });

    const [row] = await rows<Record<string, unknown>>(
      migrator,
      `SELECT * FROM termsVersion WHERE number = 1`,
    );
    // One line ending: the words kept are the ones hashed.
    const kept = '# Terms\n\nThe **first** words.\n';
    expect(row).toMatchObject({
      text: kept,
      contentHash: sha256(kept),
      source: 'admin',
      publishedBy: 'user:admin',
    });
    expect(
      await rows(migrator, `RETURN fn::legal::terms_in_force().number`),
    ).toEqual([1]);
    expect(await audit()).toEqual([
      {
        action: 'PublishTerms',
        service: 'api-admin',
        actorRole: 'Admin',
        actor: 'admin',
        entity: 'termsVersion',
      },
    ]);
  });

  it('publishes the next privacy policy version on the one in force; the old one stays listed', async () => {
    const first = await publish('privacy', {
      text: '# Privacy\n\nVersion one.\n',
      basedOn: null,
    });
    expect(first.status).toBe(201);
    // dpaVersion:v1, the repo's never-published draft (data 0001), takes no number.
    expect(await first.json()).toMatchObject({ number: 1 });
    const before = (await (await list('privacy')).json()) as {
      current: { number: number; text: string };
    };
    // The editor starts from the version in force.
    expect(before.current).toEqual({
      number: 1,
      text: '# Privacy\n\nVersion one.\n',
    });
    const next = await publish('privacy', {
      text: '# Privacy\n\nVersion two.\n',
      basedOn: 1,
    });
    expect(next.status).toBe(201);
    const listed = (await (await list('privacy')).json()) as {
      current: { number: number; text: string };
      data: Record<string, unknown>[];
    };
    expect(listed.current.number).toBe(2);
    expect(
      listed.data.map((v) => [v['number'], v['source'], v['publishedBy']]),
    ).toEqual([
      [2, 'admin', 'admin'],
      [1, 'admin', 'admin'],
    ]);
    // Version 1 is kept, word for word.
    expect(
      await rows(
        migrator,
        `SELECT VALUE text FROM dpaVersion WHERE number = 1`,
      ),
    ).toEqual(['# Privacy\n\nVersion one.\n']);
  });

  it('refuses a stale edit with 409 document_changed, writing nothing', async () => {
    const before = (await audit()).length;
    const stale = await publish('privacy', { text: 'Old base', basedOn: 1 });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('document_changed');
    const first = await publish('privacy', { text: 'No base', basedOn: null });
    expect(await code(first)).toBe('document_changed');
    expect((await audit()).length).toBe(before);
  });

  it('two admins publishing on the same version at once: one is published, the other gets 409', async () => {
    const [a, b] = await Promise.all([
      publish('terms', { text: 'Terms by one admin', basedOn: 1 }),
      publish('terms', { text: 'Terms by another admin', basedOn: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await code(loser)).toBe('document_changed');
    expect(
      await rows(
        migrator,
        `SELECT VALUE number FROM termsVersion ORDER BY number`,
      ),
    ).toEqual([1, 2]);
  });

  it('takes the longest text the editor allows, in any script and escaping; one character more is refused by its rule, not by size', async () => {
    // 200,000 characters: half "ü", half a control character JSON escapes to 6 bytes.
    const text = 'ü'.repeat(100_000) + '\u0001'.repeat(100_000);
    const longest = await publish('privacy', { text, basedOn: 2 });
    expect(longest.status).toBe(201);
    expect(await longest.json()).toMatchObject({ number: 3 });
    const over = await publish('privacy', { text: `${text}x`, basedOn: 3 });
    expect(over.status).toBe(400);
    expect(await code(over)).toBe('validation_failed');
  });

  it('is for Admin and above (D1): a moderator can neither list nor publish', async () => {
    const moderator = as('user_moderator', 'Moderator');
    expect((await list('terms', moderator)).status).toBe(403);
    expect(
      (await publish('terms', { text: 'No', basedOn: 2 }, moderator)).status,
    ).toBe(403);
    expect((await list('terms', {})).status).toBe(401);
    expect((await list('nonsense')).status).toBe(404);
    expect(
      await rows(migrator, `SELECT VALUE number FROM termsVersion`),
    ).toHaveLength(2);
  });
});
