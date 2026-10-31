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
 * the record approval waits for (streamThumbnail, libs/database images.int-spec.ts) is claimed as
 * pending before Bunny is asked and confirmed only once Bunny said OK. A resubmit with the same
 * picture doesn't ask again; a removed picture gives way to Bunny's own frame, even when the last
 * OK was never recorded; and one submit at a time talks to Bunny about a story. Bunny Stream is an in-memory stand-in recording each call (the
 * set-thumbnail call itself was tested on dev, R1); media links are signed with test keys.
 */
class FakeStream implements BunnyStream {
  readonly videos = new Map<string, StreamVideo>();
  readonly calls: { call: 'set' | 'reset'; videoId: string; url: string }[] =
    [];
  /** How many of the next thumbnail calls fail, as Bunny's API down would. */
  failing = 0;
  /** Set: the next thumbnail call waits for it (a slow Bunny); `called` resolves on arrival. */
  gate?: Promise<void>;
  called?: () => void;
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
    await this.answer();
    this.calls.push({ call: 'set', videoId, url });
  }
  async resetThumbnail(videoId: string, url: string) {
    await this.answer();
    this.calls.push({ call: 'reset', videoId, url });
  }
  private async answer() {
    const gate = this.gate;
    this.gate = undefined;
    this.called?.();
    if (gate) await gate;
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
  /** api-user's own database login, which the app uses (a write of it can be made to fail). */
  let service: Surreal;
  let failConfirm = false;
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
      `SELECT videoId, imagePath, state FROM streamThumbnail WHERE story = type::record('story', $id)`,
      { id },
    );
  /** A video story with its own picture, both arrived; returns ids and the version to submit. */
  async function videoWithPicture() {
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
    return { id, video, path, version: 3 };
  }
  const removePicture = async (id: string) => {
    const removed = await call('PATCH', `/v1/stories/${id}`, {
      body: { image: null },
      headers: {
        'if-match': `"${(await story(id)).version}"`,
        'content-type': 'application/merge-patch+json',
      },
    });
    expect(removed.status).toBe(200);
    return removed.body.version as number;
  };
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
    service = await t.service('api_user');
    // A database failure on exactly the confirm write, when a test asks for one.
    const query = service.query.bind(service);
    service.query = ((sql: string, vars?: Record<string, unknown>) => {
      if (failConfirm && /state = 'confirmed'/.test(sql)) {
        failConfirm = false;
        throw new Error('The database went away');
      }
      return query(sql, vars);
    }) as typeof service.query;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(service)
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
    bunny.calls.length = 0;
    const { id, video, path, version } = await videoWithPicture();

    // Bunny down for every try: the story stays a draft, and the row is only pending (nothing
    // vouched for); submit again.
    bunny.failing = 3;
    const down = await submit(id, version);
    expect([down.status, down.body.code]).toEqual([
      503,
      'thumbnail_unavailable',
    ]);
    expect((await story(id)).status).toBe('draft');
    expect(await recorded(id)).toEqual([
      { videoId: video, imagePath: path, state: 'pending' },
    ]);

    // One failed try is retried within the same submit (Bunny said no, so no lease is left).
    bunny.failing = 1;
    const before = Date.now();
    expect((await submit(id, version)).status).toBe(200);
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
    expect(await recorded(id)).toEqual([
      { videoId: video, imagePath: path, state: 'confirmed' },
    ]);

    // Sent back and submitted again with the same picture: Bunny already has it.
    await sendBack(id);
    expect((await submit(id, (await story(id)).version)).status).toBe(200);
    expect(bunny.calls).toHaveLength(1);

    // Sent back again; the person removes the picture: Bunny's own frame goes back.
    await sendBack(id);
    expect((await submit(id, await removePicture(id))).status).toBe(200);
    expect(bunny.calls).toHaveLength(2);
    expect(bunny.calls[1]).toMatchObject({ call: 'reset', videoId: video });
    const frame = new URL(bunny.calls[1].url);
    expect(`${frame.origin}${frame.pathname}`).toBe(
      `https://vz-test.b-cdn.net/${video}/thumbnail_1.jpg`,
    );
    expect(await recorded(id)).toEqual([
      { videoId: video, state: 'confirmed' },
    ]);
  });

  it('Bunny took the picture but its OK was never recorded: removing the picture still puts Bunny’s frame back', async () => {
    bunny.calls.length = 0;
    const { id, video, path, version } = await videoWithPicture();
    failConfirm = true;
    expect((await submit(id, version)).status).toBe(500);
    // Bunny shows the picture now; the row only says it was asked for.
    expect(bunny.calls).toMatchObject([{ call: 'set', videoId: video }]);
    expect(await recorded(id)).toEqual([
      { videoId: video, imagePath: path, state: 'pending' },
    ]);
    expect((await story(id)).status).toBe('draft');

    const next = await removePicture(id);
    // The failed submit's lease still runs (it can't tell what Bunny did), so: a moment later.
    const busy = await submit(id, next);
    expect([busy.status, busy.body.code]).toEqual([
      409,
      'thumbnail_sync_in_progress',
    ]);
    await run(
      migrator,
      `UPDATE type::record('streamThumbnail', $id) SET leaseUntil = time::now() - 1s`,
      { id },
    );
    expect((await submit(id, next)).status).toBe(200);
    expect(bunny.calls).toHaveLength(2);
    expect(bunny.calls[1]).toMatchObject({ call: 'reset', videoId: video });
    expect(await recorded(id)).toEqual([
      { videoId: video, state: 'confirmed' },
    ]);
  });

  it('one submit at a time talks to Bunny about a story: another tab’s submit meanwhile is refused', async () => {
    bunny.calls.length = 0;
    const { id, video, path, version } = await videoWithPicture();
    let release!: () => void;
    bunny.gate = new Promise<void>((resolve) => (release = resolve));
    const atBunny = new Promise<void>((resolve) => (bunny.called = resolve));

    const first = submit(id, version);
    await atBunny;
    bunny.called = undefined;
    // While the first is still at Bunny: refused, and Bunny isn't asked.
    const second = await submit(id, version);
    expect([second.status, second.body.code]).toEqual([
      409,
      'thumbnail_sync_in_progress',
    ]);
    release();
    expect((await first).status).toBe(200);
    expect(bunny.calls).toEqual([
      { call: 'set', videoId: video, url: expect.any(String) },
    ]);
    expect(await recorded(id)).toEqual([
      { videoId: video, imagePath: path, state: 'confirmed' },
    ]);
  });
});
