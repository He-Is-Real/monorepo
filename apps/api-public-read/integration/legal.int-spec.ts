import type { INestApplication } from '@nestjs/common';
import {
  publishVersion,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { startPublicRead } from './app';

/**
 * Plan 4e: the four legal texts as /privacy, /terms and every agree page read them, on
 * api-public-read's read-only login (D13). Every response is checked against the contract.
 */
describe('GET /v1/legal/documents on SurrealDB', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    t = await TestDatabase.create();
    // Version 0 of each text comes with the migration (data/0009); an admin saves version 1.
    await publishVersion(t, 'privacyNotice', '## Privacy notice, version 1');
    ({ app, url } = await startPublicRead(t));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('serves the latest version with its words, and every version newest first', async () => {
    const res = await fetch(`${url}/v1/legal/documents/privacy-notice`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      latest: { version: number; content: string; releaseDate: string };
      versions: { version: number; releaseDate: string }[];
    };
    expect(body).toMatchObject({
      document: 'privacy-notice',
      latest: { version: 1, content: '## Privacy notice, version 1' },
    });
    expect(body.versions.map((v) => v.version)).toEqual([1, 0]);
    expect(body.versions[0].releaseDate).toBe(body.latest.releaseDate);
    // Never who saved it.
    expect(JSON.stringify(body)).not.toMatch(/user:|actor|publishedBy/);

    const again = await fetch(`${url}/v1/legal/documents/privacy-notice`, {
      headers: { 'if-none-match': String(res.headers.get('etag')) },
    });
    expect(again.status).toBe(304);
  });

  it.each([
    'terms-of-use',
    'testimony-consent',
    'social-media-sharing-consent',
  ])('serves %s’s version 0 from the migration', async (document) => {
    const res = await fetch(`${url}/v1/legal/documents/${document}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      latest: { version: number; content: string };
      versions: unknown[];
    };
    expect(body.latest.version).toBe(0);
    expect(body.latest.content.length).toBeGreaterThan(0);
    expect(body.versions).toHaveLength(1);
  });

  it('serves an older version by its number, saying whether it is the latest', async () => {
    const old = await fetch(
      `${url}/v1/legal/documents/privacy-notice/versions/0`,
    );
    expect(old.status).toBe(200);
    expect(await old.json()).toMatchObject({
      document: 'privacy-notice',
      version: 0,
      latest: false,
    });
    const current = await fetch(
      `${url}/v1/legal/documents/privacy-notice/versions/1`,
    );
    expect(await current.json()).toMatchObject({
      version: 1,
      content: '## Privacy notice, version 1',
      latest: true,
    });
  });

  it.each([
    '/v1/legal/documents/privacy',
    '/v1/legal/documents/privacy-notice/versions/2',
    '/v1/legal/documents/privacy-notice/versions/-1',
    '/v1/legal/documents/privacy-notice/versions/v1',
  ])('answers 404 for %s', async (path) => {
    const res = await fetch(`${url}${path}`);
    expect(res.status).toBe(404);
  });
});
