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
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  CLERK_BACKEND,
  ClerkBackendApi,
} from '../src/app/erasure/clerk-backend';
import { BUNNY_STORAGE } from '../src/app/stories/bunny-storage';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
  type StreamVideo,
} from '../src/app/stories/bunny-stream';

/**
 * Decision T, option B: a person's request isn't cut off when their Clerk pass (60 s, often
 * less by the time it arrives) runs out midway. surrealdb.js 2.0.8 ends a session at its token's
 * `exp` (#164), so api-user asks Clerk for a fresh pass for the same session when the person's
 * own can't last as long as the work may take, and the database still does the work as them
 * (D27). Through api-user's real AppModule, real `ClerkBackendApi` and a real SurrealDB; Clerk's
 * Backend API is a stand-in at its HTTP boundary that signs passes with the test instance's key,
 * as Clerk signs them with the dev instance's. Bunny Stream is an in-memory stand-in.
 *
 * No timing: a pass that "runs out midway" is one api-user checks at a moment of its life (its
 * Clerk config's clock) but which had expired before the request was sent, so the database
 * refuses it for any work at all. Only a fresh pass can get the work done.
 */
class FakeStream implements BunnyStream {
  readonly videos = new Map<string, StreamVideo>();
  asked = 0;
  async createVideo() {
    const id = randomUUID();
    this.videos.set(id, { status: 0, length: 0 });
    return id;
  }
  async video(id: string) {
    this.asked++;
    return this.videos.get(id) ?? null;
  }
  async deleteVideo(id: string) {
    this.videos.delete(id);
  }
  sign(videoId: string, now?: number) {
    return signUpload('42', 'library-key', videoId, now);
  }
}

const SECRET_KEY = 'sk_test_fresh_pass_stand_in';

/** Clerk's `POST /v1/sessions/{id}/tokens`, as Clerk answers it (checked on dev, 2026-10-31). */
class FakeClerkApi {
  /** Live sessions: session id → Clerk user id. */
  readonly sessions = new Map<string, string>();
  readonly asked: { sessionId: string; seconds: number }[] = [];
  down = false;
  constructor(private readonly clerk: () => TestClerk) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const match = /^\/v1\/sessions\/([^/]+)\/tokens$/.exec(url.pathname);
    const auth = (init?.headers as Record<string, string>)['Authorization'];
    if (!match || init?.method !== 'POST' || auth !== `Bearer ${SECRET_KEY}`) {
      return Response.json({ errors: [] }, { status: 400 });
    }
    const sessionId = match[1];
    const seconds = (JSON.parse(String(init.body)) as Record<string, number>)[
      'expires_in_seconds'
    ];
    this.asked.push({ sessionId, seconds });
    if (this.down) return new Response('', { status: 503 });
    const sub = this.sessions.get(sessionId);
    if (!sub) {
      return Response.json(
        {
          errors: [
            { code: 'resource_not_found', message: 'Session not found' },
          ],
        },
        { status: 404 },
      );
    }
    const now = Math.floor(Date.now() / 1000);
    // Like Clerk's: the session's claims, no `azp` (no browser asked), the lifetime asked for.
    const jwt = this.clerk().token(sub, {
      sid: sessionId,
      iat: now,
      nbf: now - 5,
      exp: now + seconds,
      azp: undefined,
    });
    return Response.json({ object: 'token', jwt });
  };
}

describe('a person’s request outlives their own pass (decision T, option B)', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
  let clerk: TestClerk;
  const clerkApi = new FakeClerkApi(() => clerk);
  let t: TestDatabase;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;
  /** When set, the time (s) api-user checks tokens at; else the real clock. */
  let checkedAt: number | undefined;
  /** A pass's life, long gone by the time any test runs: issued, checked, expired. */
  const issued = Math.floor(Date.now() / 1000) - 600;
  const gone = { iat: issued, nbf: issued - 5, exp: issued + 60 };
  const key = () => `fresh-pass-key-${++keySeq}-${'x'.repeat(16)}`;

  /** A pass for a live Clerk session of `who`, just issued (Clerk's last 60 s). */
  function pass(who: string) {
    const sessionId = `sess_${who}${randomUUID().replace(/-/g, '')}`;
    clerkApi.sessions.set(sessionId, `user_${who}`);
    const exp = Math.floor(Date.now() / 1000) + 60;
    return {
      sessionId,
      token: clerk.token(`user_${who}`, { sid: sessionId, exp }),
    };
  }

  /**
   * A pass for a live Clerk session of `who` that api-user checks halfway through its life, but
   * that had expired before it was sent: the database refuses it, whenever the request runs.
   */
  function expired(who: string) {
    const sessionId = `sess_${who}${randomUUID().replace(/-/g, '')}`;
    clerkApi.sessions.set(sessionId, `user_${who}`);
    return {
      sessionId,
      token: clerk.token(`user_${who}`, { sid: sessionId, ...gone }),
    };
  }

  async function call(
    method: string,
    path: string,
    token: string,
    {
      body,
      headers = {},
    }: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
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

  /** A video draft whose file has arrived at Bunny: ready to submit, at version 2. */
  async function readyVideo(who: string) {
    await createPeople(t, { [who]: `user_${who}` });
    await grantAll(await t.person(`user_${who}`));
    const { token } = pass(who);
    const created = await call('POST', '/v1/stories', token, {
      body: {
        title: 'My story',
        primaryFormat: 'video',
        tagSlugs: ['healing'],
      },
      headers: { 'idempotency-key': key() },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const upload = await call('POST', `/v1/stories/${id}/upload-url`, token, {
      body: {
        format: 'video',
        contentType: 'video/mp4',
        fileSizeBytes: 2_000_000,
        durationSeconds: 30,
      },
      headers: { 'if-match': '"1"', 'idempotency-key': key() },
    });
    expect(upload.status).toBe(200);
    Object.assign(bunny.videos.get(upload.body.headers.VideoId) ?? {}, {
      status: 4,
      length: 30,
    });
    // The upload link is slow work too (a fresh pass of its own): tests count from here.
    clerkApi.asked.length = 0;
    return id;
  }

  const submit = (id: string, token: string) =>
    call('POST', `/v1/stories/${id}/submit`, token, {
      headers: { 'if-match': '"2"', 'idempotency-key': key() },
    });
  /** `submit`, with api-user checking the token while it was still valid (see `expired`). */
  async function submitLate(id: string, token: string) {
    checkedAt = gone.iat + 30;
    try {
      return await submit(id, token);
    } finally {
      checkedAt = undefined;
    }
  }
  const statusOf = async (id: string) =>
    (
      await rows(
        migrator,
        `SELECT VALUE status FROM type::record('story', $id)`,
        {
          id,
        },
      )
    )[0];

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
      .useValue({
        ...parseClerkConfig({
          issuer: clerk.issuer,
          publicKeyPem: clerk.publicKeyPem,
          authorizedParties: clerk.authorizedParty,
        }),
        clock: () => checkedAt ?? Date.now() / 1000,
      })
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .overrideProvider(CLERK_BACKEND)
      .useValue(
        new ClerkBackendApi(
          { get: async () => SECRET_KEY },
          'clerk-secret-key',
          null,
          clerkApi.fetch,
        ),
      )
      .overrideProvider(BUNNY_STREAM)
      .useValue(bunny)
      .overrideProvider(BUNNY_STORAGE)
      .useValue(null)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
    await run(
      await t.service('api_admin'),
      `UPSERT tag:healing SET name = 'Healing', category = 'theme'`,
    );
  });
  beforeEach(() => {
    clerkApi.asked.length = 0;
    clerkApi.down = false;
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('a submit whose pass has run out by the time the database sees it completes as the person, on one fresh pass from Clerk', async () => {
    const id = await readyVideo('ann');
    const late = expired('ann');
    const before = bunny.asked;

    const sent = await submitLate(id, late.token);

    // The consent check, the media check at Bunny, the limits and the submission itself all ran
    // in the person's database session, which their own pass could no longer open.
    expect(sent.status).toBe(200);
    expect(bunny.asked).toBe(before + 1);
    expect(await statusOf(id)).toBe('pending');
    // One pass for the whole request (the consent guard's session, then submit's), for this
    // session only, lasting the database's five minutes plus surrealdb.js's one-minute margin.
    expect(clerkApi.asked).toEqual([
      { sessionId: late.sessionId, seconds: 360 },
    ]);
  });

  it('a session that has ended (signed out, revoked, blocked or deleted) stops the request: 401, nothing submitted', async () => {
    const id = await readyVideo('bob');
    const late = expired('bob');
    clerkApi.sessions.delete(late.sessionId);
    const before = bunny.asked;

    const refused = await submitLate(id, late.token);

    expect(refused.status).toBe(401);
    expect(bunny.asked).toBe(before);
    expect(await statusOf(id)).toBe('draft');
  });

  it('Clerk not answering fails the request with a retryable 503, never carrying on with a pass too short for it', async () => {
    const id = await readyVideo('cat');
    clerkApi.down = true;

    const failed = await submitLate(id, expired('cat').token);

    expect([failed.status, failed.body.code]).toEqual([
      503,
      'sign_in_unavailable',
    ]);
    expect(await statusOf(id)).toBe('draft');
    // Once Clerk answers again, the same submit goes through.
    clerkApi.down = false;
    expect((await submitLate(id, expired('cat').token)).status).toBe(200);
  });

  it('quick requests on a pass with time left never call Clerk; slow ones always take one fresh pass', async () => {
    const id = await readyVideo('dan');
    const account = await call('GET', '/v1/account', pass('dan').token);
    expect(account.status).toBe(200);
    expect(clerkApi.asked).toEqual([]);

    const live = pass('dan');
    expect((await submit(id, live.token)).status).toBe(200);
    expect(clerkApi.asked).toEqual([
      { sessionId: live.sessionId, seconds: 360 },
    ]);
  });
});
