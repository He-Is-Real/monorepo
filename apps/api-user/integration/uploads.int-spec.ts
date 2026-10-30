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
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { tusSignature } from '@heisreal/story-cards';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
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
    this.videos.set(id, { title, status: 0, length: 0 });
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
        if (!mode || !/CREATE (ONLY )?type::record\('uploadGrant'/.test(sql)) {
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

describe('video and audio uploads', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
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
    await grantAll(await t.person(`user_${who}`));
    await run(
      await t.service('api_admin'),
      `UPSERT tag:healing SET name = 'Healing', category = 'theme'`,
    );
  }
  const draft = async (who: string, format: 'video' | 'audio' = 'video') => {
    const res = await call('POST', '/v1/stories', who, {
      body: { title: 'My story', primaryFormat: format, tagSlugs: ['healing'] },
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
      `SELECT VALUE record::id(id) FROM uploadGrant WHERE person = type::record('user', $who)`,
      { who },
    );
  const submit = (who: string, id: string, version: number) =>
    call('POST', `/v1/stories/${id}/submit`, who, {
      headers: { 'if-match': `"${version}"`, 'idempotency-key': key() },
    });
  const media = async (id: string) =>
    rows(migrator, `SELECT VALUE media FROM type::record('story', $id)`, {
      id,
    });
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
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
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
        `SELECT status, media[0].bunnyVideoId AS v FROM type::record('story', $id)`,
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
});
