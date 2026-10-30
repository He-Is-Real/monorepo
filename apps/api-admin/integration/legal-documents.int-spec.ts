import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import {
  type DocumentStore,
  RECORDS_STORE,
} from '../src/app/legal-documents/document-store';

/**
 * The legal documents (D121, D123; Joel, 2026-10-30) through api-admin's real AppModule on its
 * own login (D13) and a real SurrealDB 3.2.4, as /admin/legal calls them: preview, publish (the
 * first version, then the next), the versions list. The admin's upload is the record, stored
 * and bound exactly as uploaded (D123: admins are trusted, nothing is scanned or rewritten).
 * Only the bucket is a stand-in (it keeps what it's given, write-once, like the real one): what's
 * checked is what api-admin decides and what the database keeps. Every answer is checked
 * against api-admin.yaml.
 */
describe('legal documents (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;
  /** The bucket: path → bytes. */
  const records = new Map<string, Buffer>();
  const bucket: DocumentStore = {
    async create(path, bytes) {
      if (!records.has(path)) records.set(path, Buffer.from(bytes));
    },
  };

  const sha256 = (data: Buffer | string) =>
    createHash('sha256').update(data).digest('hex');
  const as = (clerkUserId: string, role = 'Admin') => ({
    authorization: `Bearer ${clerk.token(clerkUserId, { role })}`,
  });

  /**
   * A PDF's bytes (the same words make the same bytes). api-admin never reads them: only the
   * file's name must end in .pdf (Joel, 2026-10-30).
   */
  const pdf = async (words: string) =>
    Buffer.from(`%PDF-1.7\n% ${words}\n%%EOF\n`, 'latin1');

  const upload = (
    file: Buffer,
    fields: Record<string, string> = {},
    name = 'policy.pdf',
  ) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    body.append(
      'pdf',
      new Blob([new Uint8Array(file)], { type: 'application/pdf' }),
      name,
    );
    return body;
  };
  async function preview(
    document: string,
    file: Buffer,
    who = as('user_admin'),
    name = 'policy.pdf',
  ) {
    const res = await fetch(
      `${url}/v1/admin/legal-documents/${document}/previews`,
      {
        method: 'POST',
        headers: who,
        body: upload(file, {}, name),
      },
    );
    expect(await contract.check('POST', res)).toEqual([]);
    return res;
  }
  /** Previews `file`, then publishes it with `text` (the admin page's two steps). */
  async function publish(
    document: string,
    file: Buffer,
    fields: Record<string, string> = {},
    who = as('user_admin'),
    name = 'policy.pdf',
  ) {
    const shown = (await (await preview(document, file, who, name)).json()) as {
      pdfSha256?: string;
    };
    const text = fields['text'] ?? `# ${document}\n\nThe words.\n`;
    const res = await fetch(
      `${url}/v1/admin/legal-documents/${document}/versions`,
      {
        method: 'POST',
        headers: who,
        body: upload(
          file,
          {
            text,
            textSha256: sha256(text),
            pdfSha256: shown.pdfSha256 ?? sha256(file),
            changeNote: 'First version',
            basedOn: '',
            ...fields,
          },
          name,
        ),
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
      {
        headers: who,
      },
    );
    expect(await contract.check('GET', res)).toEqual([]);
    return res;
  };
  const audit = () =>
    rows<Record<string, unknown>>(
      migrator,
      `SELECT action, service, actorRole, record::id(actor) AS actor,
         <string> entity AS entity, createdAt FROM auditLog
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
      .overrideProvider(RECORDS_STORE)
      .useValue(bucket)
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('previews the upload as it is: its hash and size, nothing stored', async () => {
    const file = await pdf('Terms of use, version 1');
    const res = await preview('terms', file);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      document: 'terms',
      pdfSha256: sha256(file),
      pdfSize: file.length,
    });
    expect(records.size).toBe(0);
  });

  it('publishes the first terms of use: the upload, byte for byte, is the record; audited', async () => {
    const file = await pdf('Terms of use, version 1');
    const res = await publish('terms', file, { changeNote: 'First terms' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'v1', version: 1 });

    const [row] = await rows<Record<string, unknown>>(
      migrator,
      `SELECT * FROM termsVersion:v1`,
    );
    expect(records.get(String(row['pdfPath']))?.equals(file)).toBe(true);
    expect(row['pdfSha256']).toBe(sha256(file));
    expect(row['pdfSize']).toBe(file.length);
    expect(row['pdfPath']).toBe(`legal/terms/v1/${sha256(file)}.pdf`);
    // One copy only: nothing else is stored (Joel, 2026-10-30).
    expect([...records.keys()]).toEqual([row['pdfPath']]);
    expect(row).toMatchObject({
      source: 'admin',
      changeNote: 'First terms',
      requiresReacceptance: false,
      publishedBy: 'user:admin',
    });
    expect(await rows(migrator, `RETURN fn::legal::terms_in_force()`)).toEqual([
      'termsVersion:v1',
    ]);
    expect(await audit()).toEqual([
      {
        action: 'PublishTerms',
        service: 'api-admin',
        actorRole: 'Admin',
        actor: 'admin',
        entity: 'termsVersion:v1',
      },
    ]);
  });

  it('publishes the next privacy policy version on top of the one in force; the old one stays listed', async () => {
    const first = await publish('privacy', await pdf('Privacy policy 1'), {
      changeNote: 'First policy',
    });
    // dpaVersion:v1 is the repo's draft (data 0001), so the first published one is v2.
    expect(await first.json()).toEqual({ id: 'v2', version: 1 });
    const next = await publish('privacy', await pdf('Privacy policy 2'), {
      changeNote: 'Clearer words',
      requiresReacceptance: 'true',
      basedOn: 'v2',
    });
    expect(next.status).toBe(201);
    const listed = (await (await list('privacy')).json()) as {
      current: { id: string };
      data: Record<string, unknown>[];
    };
    expect(listed.current.id).toBe('v3');
    expect(
      listed.data.map((v) => [
        v['id'],
        v['changeNote'],
        v['requiresReacceptance'],
        v['publishedBy'],
      ]),
    ).toEqual([
      ['v3', 'Clearer words', true, 'admin'],
      ['v2', 'First policy', false, 'admin'],
    ]);
    expect(
      await rows(migrator, `SELECT VALUE materiality FROM dpaVersion:v3`),
    ).toEqual(['material']);
  });

  it('publishes only what was previewed, against the version in force, and each PDF once', async () => {
    const file = await pdf('Privacy policy 3');
    for (const fields of [
      { textSha256: sha256('something else'), basedOn: 'v3' } as Record<
        string,
        string
      >,
      { pdfSha256: sha256('another file'), basedOn: 'v3' },
    ]) {
      const res = await publish('privacy', file, fields);
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { errors: { code: string }[] }).errors[0].code,
      ).toBe('preview_mismatch');
    }
    const stale = await publish('privacy', file, { basedOn: 'v2' });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe(
      'document_changed',
    );
    const first = await publish('privacy', file, { basedOn: '' });
    expect(((await first.json()) as { code: string }).code).toBe(
      'document_changed',
    );
    const again = await publish('privacy', await pdf('Privacy policy 2'), {
      basedOn: 'v3',
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe(
      'already_published',
    );
  });

  it('two admins publishing on the same version at once: one is published, the other gets 409 document_changed', async () => {
    const [a, b] = await Promise.all([
      publish('terms', await pdf('Terms by one admin'), { basedOn: 'v1' }),
      publish('terms', await pdf('Terms by another admin'), { basedOn: 'v1' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(((await loser.json()) as { code: string }).code).toBe(
      'document_changed',
    );
    expect(
      await rows(
        migrator,
        `SELECT VALUE record::id(id) FROM termsVersion ORDER BY id`,
      ),
    ).toEqual(['v1', 'v2']);
  });

  it('refuses a file whose name doesn’t end in .pdf, storing and writing nothing', async () => {
    const before = [records.size, (await audit()).length];
    const res = await publish(
      'terms',
      await pdf('Terms as a Word file'),
      { basedOn: 'v2' },
      as('user_admin'),
      'terms.docx',
    );
    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { errors: { code: string }[] }).errors[0].code,
    ).toBe('pdf_not_a_pdf');
    expect([records.size, (await audit()).length]).toEqual(before);
  });

  it('never reads the file: any bytes named .pdf (in any case) are published as they are', async () => {
    const file = Buffer.from('Not what a PDF starts with', 'latin1');
    const res = await publish(
      'terms',
      file,
      { basedOn: 'v2', changeNote: 'Named in capitals' },
      as('user_admin'),
      'TERMS.PDF',
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [path] = await rows<string>(
      migrator,
      `SELECT VALUE pdfPath FROM type::record('termsVersion', $id)`,
      { id },
    );
    expect(records.get(path)?.equals(file)).toBe(true);
  });

  it('refuses a PDF over 10 MB before reading it', async () => {
    const big = Buffer.concat([
      await pdf('Big'),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
    ]);
    const res = await preview('terms', big);
    expect(res.status).toBe(413);
  });

  it('is for Admin and above (D1): a moderator can neither list, preview nor publish', async () => {
    const moderator = as('user_moderator', 'Moderator');
    expect((await list('terms', moderator)).status).toBe(403);
    expect((await preview('terms', await pdf('No'), moderator)).status).toBe(
      403,
    );
    expect((await list('terms', {})).status).toBe(401);
    expect((await list('nonsense')).status).toBe(404);
  });
});
