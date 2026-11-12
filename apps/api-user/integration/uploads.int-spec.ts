import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  agree,
  agreeAll,
  createPeople,
  processed,
  publishVersion,
  rows,
  run,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { tusSignature } from '@heisreal/story-cards';
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
 * Video and audio uploads (M2 plan PR 7) through api-user's real AppModule, as /share calls it:
 * RequestUpload creates the video, puts it on the draft (D80) and signs a link for it; a new file
 * replaces it and deletes the old one; a resume signs the same video; the limits (D113) are
 * checked before anything is created; submit checks the file arrived and is within today's
 * limits. Bunny Stream is an in-memory stand-in (the dev behavioural suite uploads to the real
 * one); the database is real. Every answer is checked against api-user.yaml.
 */
class FakeStream implements BunnyStream {
  readonly videos = new Map<string, StreamVideo & { title: string }>();
  readonly deleted: string[] = [];
  async createVideo(title: string) {
    const id = randomUUID();
    this.videos.set(id, { title, status: 0, length: 0, mp4Height: null });
    return id;
  }
  async video(id: string) {
    return this.videos.get(id) ?? null;
  }
  async deleteVideo(id: string) {
    this.videos.delete(id);
    this.deleted.push(id);
  }
  sign(videoId: string, now?: number) {
    return signUpload('42', 'library-key', videoId, now);
  }
  /** What Bunny would show once the browser's upload finished and it read the file. */
  arrived(id: string, length = 30) {
    const v = this.videos.get(id);
    if (v) Object.assign(v, { status: 4, length });
  }
}

/**
 * Fault injection on api-user's own login: the next upload grant's write either commits and
 * its answer is lost on the way back (`lost`), or never reaches the database (`unsent`). Both
 * look the same to api-user: a connection that failed with no answer.
 */
const fault: { next?: 'lost' | 'unsent' } = {};
function withFaults(db: Surreal): Surreal {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'query') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string, vars?: Record<string, unknown>) => {
        const mode = fault.next;
        if (!mode || !/CREATE (ONLY )?type::record\('storyFile'/.test(sql)) {
          return target.query(sql, vars);
        }
        fault.next = undefined;
        const responses = async () => {
          if (mode === 'lost') await target.query(sql, vars).json().responses();
          throw new Error('WebSocket closed before the answer arrived');
        };
        return { json: () => ({ responses }) };
      };
    },
  });
}

/**
 * The images zone over HTTP, answering as Bunny's S3 does: a HEAD says whether a file is there; a
 * GET with `Range: bytes=0-N` answers 206 with those bytes and `Content-Range: bytes 0-N/<size>`
 * (the picture check at submit). `down`: it answers 503 to everything. `reply`: the answer to a
 * GET for a file that's there, in its place (a zone answering oddly).
 */
class FakeZone {
  readonly files = new Map<string, Uint8Array>();
  asked = 0;
  down = false;
  reply: ((file: Uint8Array) => Response) | null = null;
  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    this.asked++;
    const url = new URL(String(input));
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    const path = decodeURIComponent(url.pathname.slice('/test-zone/'.length));
    if (this.down) return new Response('unavailable', { status: 503 });
    const file = this.files.get(path);
    if (!file) return new Response(null, { status: 404 });
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    if (this.reply) return this.reply(file);
    const range = /^bytes=0-(\d+)$/.exec(
      new Headers(init?.headers).get('range') ?? '',
    );
    if (!range) return new Response(file.slice(), { status: 200 });
    if (file.length === 0) return new Response(null, { status: 416 });
    const part = file.slice(0, Number(range[1]) + 1);
    return new Response(part, {
      status: 206,
      headers: {
        'content-range': `bytes 0-${part.length - 1}/${file.length}`,
      },
    });
  }) as typeof fetch;
}

/**
 * A WebP of `size` bytes as browsers make them (headers seen 2026-11-09): Chrome's `VP8X` with an
 * sRGB colour profile (flags 0x20, plus 0x10 with transparency), Firefox's lossy `VP8 `, or a
 * lossless `VP8L`. The rest is zeros: the check reads only the first 40 bytes.
 */
function webp({
  size = 40_000,
  width = 1200,
  height = 900,
  chunk = 'VP8X',
  flags = 0x20,
}: {
  size?: number;
  width?: number;
  height?: number;
  chunk?: 'VP8X' | 'VP8 ' | 'VP8L';
  flags?: number;
} = {}): Uint8Array {
  const b = Buffer.alloc(size);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(size - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(chunk, 12, 'latin1');
  if (chunk === 'VP8X') {
    b.writeUInt32LE(10, 16);
    b[20] = flags;
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
    if (flags & 0x20) b.write('ICCP', 30, 'latin1');
  } else if (chunk === 'VP8 ') {
    b.writeUInt32LE(size - 20, 16);
    b.set([0x10, 0x23, 0x00, 0x9d, 0x01, 0x2a], 20);
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else {
    b.writeUInt32LE(size - 20, 16);
    b[20] = 0x2f;
    b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  }
  return new Uint8Array(b);
}

describe('video and audio uploads', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
  const zone = new FakeZone();
  const images = new BunnyImageStore(
    {
      name: 'test-zone',
      password: 'zone-password',
      host: 'uk-s3.storage.bunnycdn.com',
      region: 'uk',
    },
    zone.fetch,
  );
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let admin: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;
  const key = () => `upload-key-${++keySeq}-${'x'.repeat(16)}`;

  async function call(
    method: string,
    path: string,
    who: string,
    {
      body,
      headers = {},
    }: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${clerk.token(`user_${who}`)}`,
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
  async function person(who: string) {
    await createPeople(t, { [who]: `user_${who}` });
    await agreeAll(await t.person(`user_${who}`));
    await run(
      await t.service('api_admin'),
      `UPSERT theme:healing SET name = 'Healing', category = themeCategory:other`,
    );
  }
  const draft = async (who: string, format: 'video' | 'audio' = 'video') => {
    const res = await call('POST', '/v1/stories', who, {
      body: { title: 'My story', primaryFormat: format, themeIds: ['healing'] },
      headers: { 'idempotency-key': key() },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const FILE = {
    format: 'video',
    contentType: 'video/mp4',
    fileSizeBytes: 2_000_000,
    durationSeconds: 30,
  };
  const upload = (
    who: string,
    id: string,
    version: number,
    body: object = FILE,
    idempotencyKey = key(),
  ) =>
    call('POST', `/v1/stories/${id}/upload-url`, who, {
      body,
      headers: {
        'if-match': `"${version}"`,
        'idempotency-key': idempotencyKey,
      },
    });
  const grants = async (who: string) =>
    rows(
      migrator,
      `SELECT VALUE record::id(id) FROM storyFile WHERE person = type::record('user', $who)`,
      { who },
    );
  const submit = (who: string, id: string, version: number) =>
    call('POST', `/v1/stories/${id}/submit`, who, {
      headers: { 'if-match': `"${version}"`, 'idempotency-key': key() },
    });
  const media = async (id: string) =>
    rows(
      migrator,
      // R12: the story's video, through its pointer.
      `SELECT VALUE IF mediaFile != NONE {
         [{ format: mediaFile.format, bunnyVideoId: record::id(mediaFile) }] } ELSE { [] }
       FROM type::record('story', $id)`,
      { id },
    );
  const settings = (fields: Record<string, unknown>) =>
    run(
      admin,
      `UPDATE submissionSettings:current MERGE object::extend($fields, { changedBy: user:upadmin })`,
      { fields },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(withFaults(await t.service('api_user')))
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
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await createPeople(t, { upadmin: 'user_upadmin' });
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('creates the video, puts it on the draft and signs a link for that video only', async () => {
    await person('ann');
    const id = await draft('ann');
    const res = await upload('ann', id, 1);
    expect(res.status).toBe(200);
    const videoId = res.body.headers.VideoId;
    expect(res.body).toEqual({
      id,
      version: 2,
      provider: 'bunny_tus',
      uploadUrl: 'https://video.bunnycdn.com/tusupload',
      method: 'POST',
      headers: {
        AuthorizationSignature: tusSignature(
          '42',
          'library-key',
          Number(res.body.headers.AuthorizationExpire),
          videoId,
        ),
        AuthorizationExpire: expect.stringMatching(/^\d+$/),
        VideoId: videoId,
        LibraryId: '42',
      },
      expiresAt: expect.any(String),
    });
    // Titled with the story id only (D69), and on the draft (D80).
    expect(bunny.videos.get(videoId)?.title).toBe(id);
    expect(await media(id)).toEqual([
      [{ format: 'video', bunnyVideoId: videoId }],
    ]);
    // The new version works for the next edit.
    const edited = await call('PATCH', `/v1/stories/${id}`, 'ann', {
      body: { description: 'Twenty years of searching' },
      headers: {
        'if-match': '"2"',
        'content-type': 'application/merge-patch+json',
      },
    });
    expect(edited.body).toEqual({ id, version: 3 });

    // Submit waits for the file (409), then goes through with that video.
    const early = await submit('ann', id, 3);
    expect([early.status, early.body.code]).toEqual([
      409,
      'media_not_uploaded',
    ]);
    // Uploaded, but Bunny hasn't read its length yet: submit waits for that too.
    Object.assign(bunny.videos.get(videoId) ?? {}, { status: 1 });
    const reading = await submit('ann', id, 3);
    expect([reading.status, reading.body.code]).toEqual([
      409,
      'media_processing',
    ]);
    // An unknown status counts as not uploaded (fail closed).
    Object.assign(bunny.videos.get(videoId) ?? {}, { status: 99, length: 30 });
    expect((await submit('ann', id, 3)).body.code).toBe('media_not_uploaded');
    bunny.arrived(videoId);
    const sent = await submit('ann', id, 3);
    expect(sent.status).toBe(200);
    expect(
      await rows(
        migrator,
        `SELECT currentStatus.status AS status, record::id(mediaFile) AS v FROM type::record('story', $id)`,
        {
          id,
        },
      ),
    ).toEqual([{ status: 'pending', v: videoId }]);
  });

  it('a new file replaces the draft’s video and deletes the old one at once; a resume re-signs the same one', async () => {
    await person('bob');
    const id = await draft('bob');
    const first = (await upload('bob', id, 1)).body.headers.VideoId;
    const second = await upload('bob', id, 2);
    expect(second.body.version).toBe(3);
    const secondId = second.body.headers.VideoId;
    expect(secondId).not.toBe(first);
    expect(bunny.deleted).toContain(first);
    expect(bunny.videos.has(first)).toBe(false);
    expect(await media(id)).toEqual([
      [{ format: 'video', bunnyVideoId: secondId }],
    ]);

    // Carrying on (after a reload, or once the link expired): the same video, nothing new.
    const count = bunny.videos.size;
    const resumed = await upload('bob', id, 3, { ...FILE, resume: true });
    expect(resumed.status).toBe(200);
    expect([resumed.body.version, resumed.body.headers.VideoId]).toEqual([
      3,
      secondId,
    ]);
    expect(bunny.videos.size).toBe(count);
    // Once the file has arrived there's nothing to resume.
    bunny.arrived(secondId);
    const done = await upload('bob', id, 3, { ...FILE, resume: true });
    expect([done.status, done.body.code]).toEqual([409, 'nothing_to_resume']);
  });

  it('processing the draft’s video steps its version, so the owner’s conditional GET sees the new media state (Codex, #188 review)', async () => {
    await person('pru');
    const id = await draft('pru');
    expect((await upload('pru', id, 1)).status).toBe(200);
    const read = (etag: string) =>
      call('GET', `/v1/account/stories/${id}`, 'pru', {
        headers: { 'if-none-match': etag },
      });
    expect((await read('"2"')).status).toBe(304);

    // Workflow's processing result (A2, R12) writes only the file's row; the story the owner
    // reads (its media state) has changed, so its version steps in the same write.
    await processed(await t.service('workflow'), id, { durationSeconds: 42 });
    const after = await read('"2"');
    expect(after.status).toBe(200);
    expect(after.body.version).toBe(3);
    expect(after.body.media).toEqual([
      expect.objectContaining({
        format: 'video',
        processing: 'ready',
        durationSeconds: 42,
        width: 1080,
        height: 1920,
      }),
    ]);
    expect((await read('"3"')).status).toBe(304);
    // A resume signs a link again without changing what the owner sees: no new version.
    const resumed = await upload('pru', id, 3, { ...FILE, resume: true });
    expect([resumed.status, resumed.body.version]).toEqual([200, 3]);
  });

  it('checks the file and the person’s limits before creating anything at Bunny', async () => {
    await person('cat');
    const id = await draft('cat');
    const before = bunny.videos.size;
    const big = await upload('cat', id, 1, {
      ...FILE,
      fileSizeBytes: 4294967297,
    });
    expect([big.status, big.body.errors]).toEqual([
      400,
      [{ pointer: '/fileSizeBytes', message: 'at most 4294967296 bytes' }],
    ]);
    const long = await upload('cat', id, 1, { ...FILE, durationSeconds: 901 });
    expect(long.body.errors).toEqual([
      { pointer: '/durationSeconds', message: 'at most 900 seconds' },
    ]);
    const type = await upload('cat', id, 1, {
      ...FILE,
      contentType: 'image/png',
    });
    expect(type.body.errors).toEqual([
      { pointer: '/contentType', message: 'an MP4, MOV or WebM file' },
    ]);
    const format = await upload('cat', id, 1, {
      ...FILE,
      format: 'audio',
      contentType: 'audio/mpeg',
    });
    expect(format.body.errors).toEqual([
      { pointer: '/format', message: 'this is a video story' },
    ]);
    expect((await upload('cat', id, 7)).status).toBe(412);
    expect(bunny.videos.size).toBe(before);

    try {
      await settings({ uploadRequestsPerHour: 1 });
      expect((await upload('cat', id, 1)).status).toBe(200);
      const again = await upload('cat', id, 2);
      expect([again.status, again.body.code]).toEqual([
        409,
        'upload_limit_reached',
      ]);
      expect(Date.parse(again.body.availableAt)).toBeGreaterThan(Date.now());
      expect(bunny.videos.size).toBe(before + 1);
      const limits = (await call('GET', '/v1/account/limits', 'cat')).body;
      expect(limits.uploads).toMatchObject({
        perHour: 1,
        usedIn7Days: 1,
        nextAvailableAt: again.body.availableAt,
      });
    } finally {
      await settings({ uploadRequestsPerHour: 10 });
    }
  });

  it('submit checks the file against the limits in force now, and that Bunny could read it', async () => {
    await person('dan');
    const id = await draft('dan', 'audio');
    const res = await upload('dan', id, 1, {
      format: 'audio',
      contentType: 'audio/mpeg',
      fileSizeBytes: 3_000_000,
      durationSeconds: 120,
    });
    const videoId = res.body.headers.VideoId;
    bunny.arrived(videoId, 120);
    try {
      // An admin lowers the length limit after the upload: "new rules apply to everyone".
      await settings({ mediaMaxSeconds: 60 });
      const over = await submit('dan', id, 2);
      expect([over.status, over.body.code]).toEqual([409, 'media_over_limit']);
    } finally {
      await settings({ mediaMaxSeconds: 900 });
    }
    // Bunny couldn't encode it.
    Object.assign(bunny.videos.get(videoId) ?? {}, { status: 5 });
    const failed = await submit('dan', id, 2);
    expect([failed.status, failed.body.code]).toEqual([409, 'media_failed']);
    bunny.arrived(videoId, 120);
    expect((await submit('dan', id, 2)).status).toBe(200);
  });

  it('an upload whose database answer is lost keeps its video, and a retry with the same key replays it without counting another (Codex #133, 1)', async () => {
    await person('fay');
    const id = await draft('fay');
    const k = key();
    fault.next = 'lost';
    const first = await upload('fay', id, 1, FILE, k);
    // The grant committed: api-user finds it by the key and answers as if nothing was lost.
    expect(first.status).toBe(200);
    const videoId = first.body.headers.VideoId;
    expect(first.body.version).toBe(2);
    expect(bunny.videos.has(videoId)).toBe(true);
    expect(bunny.deleted).not.toContain(videoId);
    expect(await media(id)).toEqual([
      [{ format: 'video', bunnyVideoId: videoId }],
    ]);

    // The browser never saw that answer either: its retry, same key, same version, replays it.
    const count = bunny.videos.size;
    const again = await upload('fay', id, 1, FILE, k);
    expect([
      again.status,
      again.body.version,
      again.body.headers.VideoId,
    ]).toEqual([200, 2, videoId]);
    expect(bunny.videos.size).toBe(count);
    expect(await grants('fay')).toEqual([videoId]);
    // Once the story is submitted, a replay signs no new link (nor once the file arrived).
    bunny.arrived(videoId);
    const done = await upload('fay', id, 1, FILE, k);
    expect([done.status, done.body.code]).toEqual([409, 'nothing_to_resume']);
    expect((await submit('fay', id, 2)).status).toBe(200);
    Object.assign(bunny.videos.get(videoId) ?? {}, { status: 0 });
    const submitted = await upload('fay', id, 1, FILE, k);
    expect([submitted.status, submitted.body.code]).toEqual([
      409,
      'story_locked',
    ]);
    // The same key for another file is refused, not replayed.
    const other = await upload('fay', id, 1, { ...FILE, fileSizeBytes: 9 }, k);
    expect([other.status, other.body.code]).toEqual([
      422,
      'idempotency_key_reused',
    ]);
  });

  it('a replay checks the file against the limits in force now, as a resume does (Codex #133 round 2)', async () => {
    await person('hal');
    const id = await draft('hal');
    const k = key();
    const first = await upload('hal', id, 1, FILE, k);
    expect(first.status).toBe(200);
    try {
      // An admin lowers the size limit after the upload started.
      await settings({ videoMaxBytes: 1_000_000 });
      const resume = await upload('hal', id, 2, { ...FILE, resume: true });
      expect([resume.status, resume.body.code]).toEqual([
        400,
        'validation_failed',
      ]);
      const replay = await upload('hal', id, 1, FILE, k);
      expect([replay.status, replay.body.code]).toEqual([
        400,
        'validation_failed',
      ]);
    } finally {
      await settings({ videoMaxBytes: 4_294_967_296 });
    }
    expect(await grants('hal')).toEqual([first.body.headers.VideoId]);
  });

  it('a grant that never reached the database is not guessed at: 503, the video kept, and the retry goes through once (Codex #133, 1)', async () => {
    await person('gus');
    const id = await draft('gus');
    const k = key();
    fault.next = 'unsent';
    const before = new Set(bunny.videos.keys());
    const first = await upload('gus', id, 1, FILE, k);
    expect([first.status, first.body.code]).toEqual([
      503,
      'upload_outcome_unknown',
    ]);
    // Its outcome was unknown, so its video stays (the sweep removes it if nothing names it).
    const made = [...bunny.videos.keys()].filter((v) => !before.has(v));
    expect(made).toHaveLength(1);
    expect(await grants('gus')).toEqual([]);

    const again = await upload('gus', id, 1, FILE, k);
    expect([again.status, again.body.version]).toEqual([200, 2]);
    expect(await grants('gus')).toEqual([again.body.headers.VideoId]);
  });

  it('a picture: api-user names its path in the story’s folder, puts it on the draft and presigns a PUT binding it; a retry replays the same path; the story says once its file arrived', async () => {
    await person('pia');
    const created = await call('POST', '/v1/stories', 'pia', {
      body: { title: 'Words', primaryFormat: 'written', body: 'x'.repeat(250) },
      headers: { 'idempotency-key': key() },
    });
    const id = created.body.id as string;
    const PICTURE = {
      format: 'image',
      contentType: 'image/webp',
      fileSizeBytes: 40_000,
      width: 900,
      height: 1200,
      alt: 'A hill at dawn',
      expectedImage: null,
    };
    const k = key();
    const res = await upload('pia', id, 1, PICTURE, k);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      version: 2,
      provider: 'bunny_s3',
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp', 'If-None-Match': '*' },
    });
    const link = new URL(res.body.uploadUrl);
    expect(link.pathname).toMatch(
      new RegExp(`^/test-zone/stories/${id}/[0-9a-f]{32}\\.webp$`),
    );
    expect(link.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    const path = link.pathname.slice('/test-zone/'.length);
    expect(res.body.path).toBe(path);
    const mine = async () =>
      (await call('GET', `/v1/account/stories/${id}`, 'pia')).body.image;
    expect(await mine()).toEqual({
      url: null,
      width: 900,
      height: 1200,
      alt: 'A hill at dawn',
      path,
      uploaded: false,
    });
    // Not there yet: never a 304, since its arrival doesn't step the version.
    const unchanged = await call('GET', `/v1/account/stories/${id}`, 'pia', {
      headers: { 'if-none-match': '"2"' },
    });
    expect(unchanged.status).toBe(200);
    zone.files.set(path, webp({ width: 900, height: 1200 }));
    expect(await mine()).toMatchObject({ path, uploaded: true });
    // Once it's known to be there, reading the story doesn't ask the zone again.
    const asked = zone.asked;
    expect(await mine()).toMatchObject({ path, uploaded: true });
    expect(zone.asked).toBe(asked);
    // A lost answer's retry: the same path, nothing new counted.
    const again = await upload('pia', id, 1, PICTURE, k);
    expect(new URL(again.body.uploadUrl).pathname).toBe(link.pathname);
    expect(await grants('pia')).toEqual([path]);

    // Asked for while the page showed no picture (another tab added this one): refused at the
    // story's own version, nothing counted (Codex #140 round 3).
    const stale = await upload('pia', id, 2, PICTURE);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('image_changed');
    expect(await grants('pia')).toEqual([path]);

    // Pictures count per hour, never towards the weekly limit (Joel, 2026-10-30: only video and
    // audio files do): with one upload a week, the next picture is still allowed.
    try {
      await settings({ uploadsPer7Days: 1 });
      const next = await upload('pia', id, 2, {
        ...PICTURE,
        expectedImage: path,
      });
      expect(next.status).toBe(200);
      expect(await grants('pia')).toHaveLength(2);
      // And /share's "uploads left this week" doesn't count them either.
      const limits = (await call('GET', '/v1/account/limits', 'pia')).body;
      expect(limits.uploads).toMatchObject({
        per7Days: 1,
        usedIn7Days: 0,
        nextAvailableAt: null,
      });
    } finally {
      await settings({ uploadsPer7Days: 5 });
    }
  });

  it('submit reads the picture’s first 40 bytes: refuses one missing, incomplete, not the recorded WebP or with hidden extras, waits when the zone is down, and marks a good one checked (Joel, 2026-10-30, R3 = A)', async () => {
    await person('pam');
    const created = await call('POST', '/v1/stories', 'pam', {
      body: {
        title: 'Words',
        primaryFormat: 'written',
        body: 'x'.repeat(250),
        themeIds: ['healing'],
      },
      headers: { 'idempotency-key': key() },
    });
    const id = created.body.id as string;
    const granted = await upload('pam', id, 1, {
      format: 'image',
      contentType: 'image/webp',
      fileSizeBytes: 40_000,
      width: 1200,
      height: 900,
      expectedImage: null,
    });
    expect(granted.status).toBe(200);
    const path = granted.body.path as string;
    const checked = async () =>
      (
        await rows(
          migrator,
          `SELECT VALUE processing FROM ONLY type::record('storyFile', $path)`,
          { path },
        )
      )[0] ?? null;
    const status = async () =>
      (await call('GET', `/v1/account/stories/${id}`, 'pam')).body.status;

    const refusals: [string, Uint8Array | null][] = [
      ['never arrived', null],
      ['incomplete', webp().subarray(0, 20_000)],
      ['empty', new Uint8Array()],
      ['another size', webp({ size: 39_000 })],
      [
        'a header that disagrees with its size',
        (() => {
          const b = webp();
          new DataView(b.buffer).setUint32(4, 50_000, true);
          return b;
        })(),
      ],
      [
        'not a WebP (a PNG named .webp)',
        (() => {
          const b = new Uint8Array(40_000);
          b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          return b;
        })(),
      ],
      ['another width and height', webp({ width: 900, height: 1200 })],
      ['location or camera data (EXIF)', webp({ flags: 0x20 | 0x08 })],
      ['XMP metadata', webp({ flags: 0x04 })],
      ['an animation', webp({ flags: 0x02 })],
    ];
    for (const [what, file] of refusals) {
      if (file) zone.files.set(path, file);
      else zone.files.delete(path);
      const refused = await submit('pam', id, 2);
      expect(refused.status, what).toBe(400);
      expect(refused.body, what).toMatchObject({
        code: 'image_not_uploaded',
        detail:
          'Your picture hasn’t finished uploading. Add it again, or remove it, then submit your story.',
      });
      expect(await checked(), what).toBeNull();
    }

    // The zone gives no clear answer: submit waits ("try again"), never a pass.
    zone.files.set(path, webp());
    zone.down = true;
    try {
      const waiting = await submit('pam', id, 2);
      expect(waiting.status).toBe(503);
      expect(waiting.body.code).toBe('uploads_unavailable');
    } finally {
      zone.down = false;
    }
    expect(await checked()).toBeNull();
    expect(await status()).toBe('draft');

    // A good picture: submitted at the version the page sent, and marked checked.
    const sent = await submit('pam', id, 2);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ id, version: 3 });
    expect(await checked()).toBe('ready');
    expect(await status()).toBe('pending');
  });

  /** A written story with a picture recorded at upload as `fileSizeBytes`, 1200 × 900. */
  async function pictureStory(who: string, fileSizeBytes = 40_000) {
    await person(who);
    const created = await call('POST', '/v1/stories', who, {
      body: {
        title: 'Words',
        primaryFormat: 'written',
        body: 'x'.repeat(250),
        themeIds: ['healing'],
      },
      headers: { 'idempotency-key': key() },
    });
    const id = created.body.id as string;
    const granted = await upload(who, id, 1, {
      format: 'image',
      contentType: 'image/webp',
      fileSizeBytes,
      width: 1200,
      height: 900,
      expectedImage: null,
    });
    expect(granted.status).toBe(200);
    return { id, path: granted.body.path as string };
  }

  /** `file` with the little-endian 32-bit value at `at` set to `value`. */
  const patched = (file: Uint8Array, at: number, value: number) => {
    new DataView(file.buffer, file.byteOffset).setUint32(at, value, true);
    return file;
  };

  it('the picture check refuses a WebP whose chunks couldn’t be real: an odd RIFF size, a VP8X header not 10 bytes long, a VP8 or VP8L header too short to hold its size, a first chunk that runs past the end (Codex, #208 review)', async () => {
    const odd = await pictureStory('pod', 40_001);
    // 40,001 bytes as recorded and as stored, but a RIFF size (39,993) no RIFF file can have.
    zone.files.set(odd.path, webp({ size: 40_001 }));
    const refusedOdd = await submit('pod', odd.id, 2);
    expect(refusedOdd.status).toBe(400);
    expect(refusedOdd.body.code).toBe('image_not_uploaded');

    const { id, path } = await pictureStory('pyx');
    const refusals: [string, Uint8Array][] = [
      ['a VP8X header of 12 bytes', patched(webp(), 16, 12)],
      ['a VP8X header of 9 bytes', patched(webp(), 16, 9)],
      ['a VP8 header of 4 bytes', patched(webp({ chunk: 'VP8 ' }), 16, 4)],
      ['a VP8L header of 2 bytes', patched(webp({ chunk: 'VP8L' }), 16, 2)],
      [
        'a first chunk longer than the file',
        patched(webp({ chunk: 'VP8 ' }), 16, 40_000),
      ],
      [
        'an odd first chunk whose padding runs past the end',
        patched(webp({ chunk: 'VP8L' }), 16, 39_981),
      ],
    ];
    for (const [what, file] of refusals) {
      zone.files.set(path, file);
      const refused = await submit('pyx', id, 2);
      expect(refused.status, what).toBe(400);
      expect(refused.body.code, what).toBe('image_not_uploaded');
    }
    // An odd first chunk whose padding byte ends the file exactly is a real one.
    zone.files.set(path, patched(webp({ chunk: 'VP8L' }), 16, 39_979));
    expect((await submit('pyx', id, 2)).status).toBe(200);
  });

  it('the picture check never passes on a zone answer that contradicts itself or stops short: 503, the story still a draft; a 200 with the whole file is read to 40 bytes and passes (Codex, #208 review)', async () => {
    const { id, path } = await pictureStory('rho');
    zone.files.set(path, webp());
    const answer = (
      status: number,
      body: Uint8Array,
      headers: Record<string, string>,
    ) => new Response(body.slice(), { status, headers });
    const contradictions: [string, (file: Uint8Array) => Response][] = [
      [
        'a range not from byte 0',
        (f) =>
          answer(206, f.slice(1, 41), {
            'content-range': 'bytes 1-40/40000',
          }),
      ],
      [
        'a shorter range than asked',
        (f) =>
          answer(206, f.slice(0, 20), {
            'content-range': 'bytes 0-19/40000',
          }),
      ],
      [
        'a range past the file’s end',
        (f) =>
          answer(206, f.slice(0, 40), { 'content-range': 'bytes 0-39/30' }),
      ],
      [
        'no total size',
        (f) => answer(206, f.slice(0, 40), { 'content-range': 'bytes 0-39/*' }),
      ],
      [
        'a Content-Length that disagrees with the range',
        (f) =>
          answer(206, f.slice(0, 40), {
            'content-range': 'bytes 0-39/40000',
            'content-length': '30',
          }),
      ],
      [
        'fewer bytes than the range says',
        (f) =>
          answer(206, f.slice(0, 25), {
            'content-range': 'bytes 0-39/40000',
          }),
      ],
      [
        'more bytes than the range says',
        (f) =>
          answer(206, f.slice(0, 41), {
            'content-range': 'bytes 0-39/40000',
          }),
      ],
      [
        'more bytes than the range says, in a later chunk',
        (f) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(f.slice(0, 40));
                c.enqueue(f.slice(40, 100));
                c.close();
              },
            }),
            { status: 206, headers: { 'content-range': 'bytes 0-39/40000' } },
          ),
      ],
      ['a 200 without a size', (f) => answer(200, f, {})],
      [
        'a 200 that stops short of its Content-Length',
        (f) => answer(200, f.slice(0, 20), { 'content-length': '40000' }),
      ],
      ['another status', () => new Response(null, { status: 302 })],
    ];
    try {
      for (const [what, reply] of contradictions) {
        zone.reply = reply;
        const waiting = await submit('rho', id, 2);
        expect(waiting.status, what).toBe(503);
        expect(waiting.body.code, what).toBe('uploads_unavailable');
      }
      expect(
        (await call('GET', `/v1/account/stories/${id}`, 'rho')).body.status,
      ).toBe('draft');
      // The range ignored: the whole file, its size in Content-Length.
      zone.reply = (f) =>
        answer(200, f, { 'content-length': String(f.length) });
      expect((await submit('rho', id, 2)).status).toBe(200);
    } finally {
      zone.reply = null;
    }
  });

  it('the picture check takes what browsers make: Chrome’s WebP with its colour profile and transparency, Firefox’s lossy one, and a lossless one', async () => {
    for (const [who, what, file] of [
      ['pen', 'Chrome, transparent', webp({ flags: 0x30 })],
      ['pip', 'Firefox, lossy', webp({ chunk: 'VP8 ' })],
      ['pol', 'lossless', webp({ chunk: 'VP8L' })],
    ] as const) {
      // One story each: a second would meet the weekly submission limit.
      await person(who);
      const created = await call('POST', '/v1/stories', who, {
        body: {
          title: 'Words',
          primaryFormat: 'written',
          body: 'x'.repeat(250),
          themeIds: ['healing'],
        },
        headers: { 'idempotency-key': key() },
      });
      const id = created.body.id as string;
      const granted = await upload(who, id, 1, {
        format: 'image',
        contentType: 'image/webp',
        fileSizeBytes: 40_000,
        width: 1200,
        height: 900,
        expectedImage: null,
      });
      zone.files.set(granted.body.path, file);
      expect((await submit(who, id, 2)).status, what).toBe(200);
      // Back for changes and sent again: checked again, still fine.
      await run(
        admin,
        `CREATE storyStatusLog CONTENT { story: type::record('story', $id), status: 'in_review', by: user:upadmin };
         CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'changesRequested', comment: 'A note', by: user:upadmin, comment: 'A little more' };`,
        { id },
      );
      const back = await call('GET', `/v1/account/stories/${id}`, who);
      expect(back.body.status).toBe('changes_requested');
      expect((await submit(who, id, back.body.version)).status, what).toBe(200);
    }
  });

  it('a written story takes no upload', async () => {
    await person('eve');
    const res = await call('POST', '/v1/stories', 'eve', {
      body: { title: 'Words', primaryFormat: 'written', body: 'x'.repeat(250) },
      headers: { 'idempotency-key': key() },
    });
    const refused = await upload('eve', res.body.id, 1);
    expect(refused.body.errors).toEqual([
      { pointer: '/format', message: 'this is a written story' },
    ]);
  });

  it('a resume or a replay signs no new link until the person agrees to the latest terms and testimony consent (plan 4e)', async () => {
    await person('rex');
    const p = await t.person('user_rex');
    const id = await draft('rex');
    const k = key();
    const first = await upload('rex', id, 1, FILE, k);
    expect(first.status).toBe(200);
    const videoId = first.body.headers.VideoId;
    const written = await call('POST', '/v1/stories', 'rex', {
      body: { title: 'Words', primaryFormat: 'written', body: 'x'.repeat(250) },
      headers: { 'idempotency-key': key() },
    });
    const PICTURE = {
      format: 'image',
      contentType: 'image/webp',
      fileSizeBytes: 40_000,
      width: 900,
      height: 1200,
      expectedImage: null,
    };
    const ki = key();
    const picture = await upload('rex', written.body.id, 1, PICTURE, ki);
    expect(picture.status).toBe(200);
    // Every way of getting a fresh link for a file already granted: a resume, a video's replay
    // (the same Idempotency-Key) and a picture's replay.
    const again = async () => {
      const rs = [
        await upload('rex', id, 2, { ...FILE, resume: true }),
        await upload('rex', id, 1, FILE, k),
        await upload('rex', written.body.id, 1, PICTURE, ki),
      ];
      return rs.map((r) => [r.status, r.body.code]);
    };
    const renewed = async () =>
      (
        await rows(
          migrator,
          `SELECT VALUE renewedAt FROM type::record('storyFile', $v)`,
          { v: videoId },
        )
      ).filter(Boolean);

    await publishVersion(t, 'termsOfUseAgreement');
    expect(await again()).toEqual(
      Array(3).fill([403, 'terms_agreement_required']),
    );
    await agree(p, 'termsOfUse');
    await publishVersion(t, 'testimonyConsent');
    expect(await again()).toEqual(
      Array(3).fill([403, 'testimony_consent_required']),
    );
    // Refused before anything was renewed: the draft wasn't touched (D71).
    expect(await renewed()).toEqual([]);

    await agree(p, 'testimonyConsent');
    expect((await again()).map(([status]) => status)).toEqual([200, 200, 200]);
    expect(await renewed()).toHaveLength(1);
  });
});
