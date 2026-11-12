import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  agreeAll,
  createPeople,
  draft,
  grantImage,
  grantUpload,
  processed,
  rows,
  run,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { MediaUrls } from '@heisreal/story-cards';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';

/**
 * The owner's own preview (M3 plan PR 2, part 1b; Joel, 2026-11-10, P1b-2): GET
 * /v1/account/stories/{id} signs the person's own video or audio, its thumbnail and their picture
 * for one hour, once Bunny has processed the file (null before), in any status; never in the list,
 * and never for anyone else (404). Through api-user's real AppModule and a real SurrealDB, with
 * signing on (test keys); every answer is checked against api-user.yaml.
 */
const HOUR_MS = 60 * 60 * 1000;

describe('my story: my own preview links', () => {
  const contract = new Contract('api-user.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;
  let app: INestApplication;
  let url: string;

  /** The signer's clock runs this far ahead of the real one (the expired-links case). */
  let ahead = 0;

  async function get(
    path: string,
    who: string,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      headers: {
        authorization: `Bearer ${clerk.token(`user_${who}`)}`,
        ...headers,
      },
    });
    expect(await contract.check('GET', res), `GET ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      etag: res.headers.get('etag'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  /**
   * A bare conditional GET over node:http: no Cache-Control from the client (fetch adds
   * `no-cache` to conditional requests, which hid Express's own 304; Codex #212 round 2).
   */
  function rawGet(path: string, who: string, ifNoneMatch: string) {
    return new Promise<{
      status: number;
      etag?: string;
      type?: string;
      text: string;
    }>((resolve, reject) => {
      const req = request(
        `${url}${path}`,
        {
          headers: {
            authorization: `Bearer ${clerk.token(`user_${who}`)}`,
            'if-none-match': ifNoneMatch,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              etag: res.headers.etag,
              type: res.headers['content-type'],
              text,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  /** When a signed link stops working, in ms. */
  const expiresAt = (link: string) =>
    Number(new URL(link).searchParams.get('expires')) * 1000;
  const expectAboutAnHour = (link: string, before: number) => {
    const left = expiresAt(link) - before;
    expect(left).toBeGreaterThan(HOUR_MS - 60_000);
    expect(left).toBeLessThanOrEqual(HOUR_MS + 60_000);
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    workflow = await t.service('workflow');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(apiUser)
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
      // Signing on, with test keys (D52's signer).
      .overrideProvider(MediaUrls)
      .useValue(
        new MediaUrls(
          {
            config: {
              streamLibraryId: '42',
              streamCdnHost: 'vz-test.b-cdn.net',
              imagesCdnHost: 'images-test.b-cdn.net',
              streamTokenKeySecret: 'stream-key',
              imagesTokenKeySecret: 'images-key',
            },
            streamKey: 'stream-token-key',
            imagesKey: 'images-token-key',
          },
          () => Date.now() + ahead,
        ),
      )
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await createPeople(t, { ann: 'user_ann', bob: 'user_bob' });
    await agreeAll(await t.person('user_ann'));
    await agreeAll(await t.person('user_bob'));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  // Part 1a (Joel, 2026-11-10): my story says when its file can't be used; worked out from the
  // file, so a new upload clears it.
  it('says my sent-back story’s file can’t be used, in the list too, until I upload another', async () => {
    const bob = await t.person('user_bob');
    const video = randomUUID();
    await draft(bob, 'bob_clip', { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video,
        story: 'bob_clip',
        person: 'bob',
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    expect(await submit(bob, 'bob_clip')).toHaveLength(1);
    const sent = await get('/v1/account/stories/bob_clip', 'bob');
    expect(sent.body).toMatchObject({ status: 'pending', mediaProblem: null });

    // Bunny failed it for good (the result writer's write).
    await run(
      workflow,
      `UPDATE type::record('storyFile', $video) SET processing = 'failed'`,
      { video },
    );
    const back = await get('/v1/account/stories/bob_clip', 'bob');
    expect(back.body).toMatchObject({
      status: 'editing',
      mediaProblem: 'unusable',
    });
    const list = await get('/v1/account/stories', 'bob');
    expect(
      list.body.data.find((s: { id: string }) => s.id === 'bob_clip'),
    ).toMatchObject({ mediaProblem: 'unusable' });

    expect(
      await grantUpload(apiUser, {
        video: randomUUID(),
        story: 'bob_clip',
        person: 'bob',
        version: back.body.version,
      }),
    ).toMatchObject({ ok: true });
    const replaced = await get('/v1/account/stories/bob_clip', 'bob');
    expect(replaced.body).toMatchObject({
      status: 'editing',
      mediaProblem: null,
    });
  });

  it('signs my own video for an hour once Bunny has processed it, in my story only', async () => {
    const ann = await t.person('user_ann');
    const video = randomUUID();
    await draft(ann, 'ann_clip', { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video,
        story: 'ann_clip',
        person: 'ann',
        version: 1,
      }),
    ).toMatchObject({ ok: true });

    // Still with Bunny: no link yet.
    const waiting = await get('/v1/account/stories/ann_clip', 'ann');
    expect(waiting.status).toBe(200);
    expect(waiting.body.media).toEqual([
      expect.objectContaining({
        format: 'video',
        playbackUrl: null,
        thumbnailUrl: null,
        processing: null,
      }),
    ]);

    await processed(workflow, 'ann_clip');
    const before = Date.now();
    const ready = await get('/v1/account/stories/ann_clip', 'ann');
    const [clip] = ready.body.media;
    expect(clip).toMatchObject({ format: 'video', processing: 'ready' });
    expect(clip.playbackUrl).toMatch(
      new RegExp(
        `^https://player\\.mediadelivery\\.net/embed/42/${video}\\?token=[0-9a-f]{64}&expires=\\d+$`,
      ),
    );
    expectAboutAnHour(clip.playbackUrl, before);

    // Never in the list, and never for anyone else.
    const list = await get('/v1/account/stories', 'ann');
    expect(
      list.body.data.find((s: { id: string }) => s.id === 'ann_clip').media,
    ).toEqual([expect.objectContaining({ playbackUrl: null })]);
    expect((await get('/v1/account/stories/ann_clip', 'bob')).status).toBe(404);

    // In any status its file is still there: sent for review, it keeps its link.
    await run(
      migrator,
      `CREATE storyStatusLog CONTENT { story: story:ann_clip, action: 'sent', actor: 'person' }`,
    );
    const sent = await get('/v1/account/stories/ann_clip', 'ann');
    expect(sent.body.status).toBe('pending');
    expect(sent.body.media[0].playbackUrl).toContain(`/embed/42/${video}?`);
  });

  it('signs my audio’s thumbnail and my picture for an hour too', async () => {
    const ann = await t.person('user_ann');
    const audio = randomUUID();
    await draft(ann, 'ann_voice', { primaryFormat: 'audio', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video: audio,
        story: 'ann_voice',
        person: 'ann',
        version: 1,
        format: 'audio',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await grantImage(apiUser, {
        story: 'ann_voice',
        person: 'ann',
        version: (
          await rows<number>(
            migrator,
            `SELECT VALUE version FROM story:ann_voice`,
          )
        )[0],
        width: 1080,
        height: 1350,
      }),
    ).toMatchObject({ ok: true });
    await processed(workflow, 'ann_voice');

    const before = Date.now();
    const { body } = await get('/v1/account/stories/ann_voice', 'ann');
    const [voice] = body.media;
    expect(voice.playbackUrl).toContain(`/embed/42/${audio}?`);
    expect(voice.thumbnailUrl).toMatch(
      new RegExp(
        `^https://vz-test\\.b-cdn\\.net/${audio}/thumbnail_0a1b2c3d\\.jpg\\?token=HS256-`,
      ),
    );
    expect(body.image.url).toMatch(
      /^https:\/\/images-test\.b-cdn\.net\/stories\/ann_voice\/a{32}\.webp\?token=HS256-/,
    );
    for (const link of [voice.playbackUrl, voice.thumbnailUrl, body.image.url])
      expectAboutAnHour(link, before);
  });

  it('answers a conditional read in full, with fresh links, once the earlier ones have expired', async () => {
    const ann = await t.person('user_ann');
    await draft(ann, 'ann_later', { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video: randomUUID(),
        story: 'ann_later',
        person: 'ann',
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    await processed(workflow, 'ann_later');
    const first = await get('/v1/account/stories/ann_later', 'ann');
    expect(first.etag).toMatch(/^"\d+"$/);

    // Two hours on, nothing about the story has changed, but its links have expired: the page
    // asking with the version it holds gets the story again, signed from now.
    ahead = 2 * HOUR_MS;
    try {
      const again = await get('/v1/account/stories/ann_later', 'ann', {
        'if-none-match': first.etag ?? '',
      });
      expect(again.status).toBe(200);
      expect(again.etag).toBe(first.etag);
      expect(expiresAt(again.body.media[0].playbackUrl)).toBeGreaterThan(
        expiresAt(first.body.media[0].playbackUrl) + HOUR_MS,
      );
      expectAboutAnHour(again.body.media[0].playbackUrl, Date.now() + ahead);

      // The same with a bare HTTP client: Express doesn't turn it into a 304 either.
      const raw = await rawGet(
        '/v1/account/stories/ann_later',
        'ann',
        first.etag ?? '',
      );
      expect(raw.status).toBe(200);
      expect(raw.etag).toBe(first.etag);
      expect(
        expiresAt(JSON.parse(raw.text).media[0].playbackUrl),
      ).toBeGreaterThan(expiresAt(first.body.media[0].playbackUrl) + HOUR_MS);

      // `If-None-Match: *` matches any version: still the story in full, with its ETag.
      const any = await rawGet('/v1/account/stories/ann_later', 'ann', '*');
      expect(any.status).toBe(200);
      expect(any.etag).toBe(first.etag);
      expect(any.type).toMatch(/^application\/json/);
      expect(JSON.parse(any.text).media[0].playbackUrl).toEqual(
        expect.any(String),
      );
    } finally {
      ahead = 0;
    }

    // A story with nothing signed still answers 304 to its own version.
    await draft(ann, 'ann_words');
    const words = await get('/v1/account/stories/ann_words', 'ann');
    expect(
      (
        await get('/v1/account/stories/ann_words', 'ann', {
          'if-none-match': words.etag ?? '',
        })
      ).status,
    ).toBe(304);
    expect(
      (await rawGet('/v1/account/stories/ann_words', 'ann', words.etag ?? ''))
        .status,
    ).toBe(304);
  });
});
