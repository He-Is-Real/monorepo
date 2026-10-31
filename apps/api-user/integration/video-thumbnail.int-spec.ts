import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  createPeople,
  grantAll,
  publishDpa,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { MediaUrls } from '@heisreal/story-cards';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  BUNNY_STORAGE,
  BunnyImageStore,
} from '../src/app/stories/bunny-storage';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
  type StreamVideo,
} from '../src/app/stories/bunny-stream';

/**
 * O1 a (Joel, 2026-10-31): a video's own picture becomes its thumbnail at Bunny Stream when the
 * story is submitted, so Bunny's player shows it too. Through api-user's real AppModule and a real
 * SurrealDB, as /share calls it: submit gives Bunny a short-lived signed link to the picture, and
 * the record approval waits for (streamThumbnail, libs/database images.int-spec.ts) is written
 * only once Bunny said OK. A resubmit with the same picture doesn't ask again; a removed picture
 * gives way to Bunny's own frame. Bunny Stream is an in-memory stand-in recording each call (the
 * set-thumbnail call itself was tested on dev, R1); media links are signed with test keys.
 */
class FakeStream implements BunnyStream {
  readonly videos = new Map<string, StreamVideo>();
  readonly calls: { call: 'set' | 'reset'; videoId: string; url: string }[] =
    [];
  /** How many of the next thumbnail calls fail, as Bunny's API down would. */
  failing = 0;
  async createVideo() {
    const id = randomUUID();
    this.videos.set(id, { status: 0, length: 0, hasOriginal: false });
    return id;
  }
  async video(id: string) {
    return this.videos.get(id) ?? null;
  }
  async deleteVideo(id: string) {
    this.videos.delete(id);
  }
  sign(videoId: string, now?: number) {
    return signUpload('42', 'library-key', videoId, now);
  }
  async setThumbnail(videoId: string, url: string) {
    this.answer();
    this.calls.push({ call: 'set', videoId, url });
  }
  async resetThumbnail(videoId: string, url: string) {
    this.answer();
    this.calls.push({ call: 'reset', videoId, url });
  }
  private answer() {
    if (this.failing > 0) {
      this.failing--;
      throw new Error('Bunny Stream set thumbnail answered 503');
    }
  }
}

class FakeImageStore extends BunnyImageStore {
  readonly arrived = new Set<string>();
  override async exists(path: string) {
    return this.arrived.has(path);
  }
}

describe('a video’s own picture becomes its thumbnail at Bunny at submit (O1 a)', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
  const images = new FakeImageStore({
    name: 'test-zone',
    password: 'zone-password',
    host: 'uk-s3.storage.bunnycdn.com',
    region: 'uk',
  });
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;
  const key = () => `thumb-key-${++keySeq}-${'x'.repeat(16)}`;

  async function call(
    method: string,
    path: string,
    {
      body,
      headers = {},
    }: { body?: unknown; headers?: Record<string, string> },
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${clerk.token('user_val')}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  const submit = (id: string, version: number) =>
    call('POST', `/v1/stories/${id}/submit`, {
      headers: { 'if-match': `"${version}"`, 'idempotency-key': key() },
    });
  const story = async (id: string) =>
    (
      await rows<{ status: string; version: number }>(
        migrator,
        `SELECT status, version FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  const recorded = (id: string) =>
    rows(
      migrator,
      `SELECT videoId, imagePath FROM streamThumbnail WHERE story = type::record('story', $id)`,
      { id },
    );
  const sendBack = (id: string) =>
    run(
      migrator,
      `UPDATE type::record('story', $id) SET status = 'changes_requested'`,
      { id },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_user'))
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
      .overrideProvider(BUNNY_STREAM)
      .useValue(bunny)
      .overrideProvider(BUNNY_STORAGE)
      .useValue(images)
      // Signing on, with test keys (D52's signer).
      .overrideProvider(MediaUrls)
      .useValue(
        new MediaUrls({
          config: {
            streamLibraryId: '42',
            streamCdnHost: 'vz-test.b-cdn.net',
            imagesCdnHost: 'images-test.b-cdn.net',
            streamTokenKeySecret: 'stream-key',
            imagesTokenKeySecret: 'images-key',
          },
          streamKey: 'stream-token-key',
          imagesKey: 'images-token-key',
        }),
      )
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
    await createPeople(t, { val: 'user_val' });
    await trustSubmitters(t, 'val');
    await grantAll(await t.person('user_val'));
    await run(
      await t.service('api_admin'),
      `UPSERT tag:healing SET name = 'Healing', category = 'theme'`,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('sets the picture at submit, then puts Bunny’s own frame back once the person removes it', async () => {
    const created = await call('POST', '/v1/stories', {
      body: {
        title: 'My story',
        primaryFormat: 'video',
        tagSlugs: ['healing'],
      },
      headers: { 'idempotency-key': key() },
    });
    const id = created.body.id as string;
    const upload = (version: number, body: object) =>
      call('POST', `/v1/stories/${id}/upload-url`, {
        body,
        headers: { 'if-match': `"${version}"`, 'idempotency-key': key() },
      });
    const video = (
      await upload(1, {
        format: 'video',
        contentType: 'video/mp4',
        fileSizeBytes: 2_000_000,
        durationSeconds: 30,
      })
    ).body.headers.VideoId as string;
    Object.assign(bunny.videos.get(video) ?? {}, { status: 4, length: 30 });
    const picture = await upload(2, {
      format: 'image',
      contentType: 'image/webp',
      fileSizeBytes: 40_000,
      width: 1280,
      height: 720,
      expectedImage: null,
    });
    const path = picture.body.path as string;
    images.arrived.add(path);

    // Bunny down for every try: the story stays a draft, nothing recorded; submit again.
    bunny.failing = 3;
    const down = await submit(id, 3);
    expect([down.status, down.body.code]).toEqual([
      503,
      'thumbnail_unavailable',
    ]);
    expect((await story(id)).status).toBe('draft');
    expect(await recorded(id)).toEqual([]);

    // One failed try is retried within the same submit.
    bunny.failing = 1;
    const before = Date.now();
    expect((await submit(id, 3)).status).toBe(200);
    expect(bunny.calls).toEqual([
      { call: 'set', videoId: video, url: expect.any(String) },
    ]);
    // Bunny fetches the picture itself, by a signed link that lasts minutes, not hours.
    const link = new URL(bunny.calls[0].url);
    expect(`${link.origin}${link.pathname}`).toBe(
      `https://images-test.b-cdn.net/${path}`,
    );
    expect(link.searchParams.get('token')).toMatch(/^HS256-/);
    const expires = Number(link.searchParams.get('expires')) * 1000;
    expect(expires - before).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(expires - before).toBeGreaterThan(9 * 60_000);
    expect(await recorded(id)).toEqual([{ videoId: video, imagePath: path }]);

    // Sent back and submitted again with the same picture: Bunny already has it.
    await sendBack(id);
    expect((await submit(id, (await story(id)).version)).status).toBe(200);
    expect(bunny.calls).toHaveLength(1);

    // Sent back again; the person removes the picture: Bunny's own frame goes back, then the
    // record goes (nothing left for approval to wait for).
    await sendBack(id);
    const removed = await call('PATCH', `/v1/stories/${id}`, {
      body: { image: null },
      headers: {
        'if-match': `"${(await story(id)).version}"`,
        'content-type': 'application/merge-patch+json',
      },
    });
    expect(removed.status).toBe(200);
    expect((await submit(id, removed.body.version)).status).toBe(200);
    expect(bunny.calls).toHaveLength(2);
    expect(bunny.calls[1]).toMatchObject({ call: 'reset', videoId: video });
    const frame = new URL(bunny.calls[1].url);
    expect(`${frame.origin}${frame.pathname}`).toBe(
      `https://vz-test.b-cdn.net/${video}/thumbnail_1.jpg`,
    );
    expect(await recorded(id)).toEqual([]);
  });
});
