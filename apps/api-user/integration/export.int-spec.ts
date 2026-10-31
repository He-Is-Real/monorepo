import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  approve,
  createPeople,
  draft,
  grantAll,
  grantImage,
  grantUpload,
  processed,
  publishDpa,
  rows,
  run,
  STORY_TEXT_PADDING,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { MediaUrls } from '@heisreal/story-cards';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  CLERK_BACKEND,
  type ClerkBackend,
  clerkProfile,
} from '../src/app/erasure/clerk-backend';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
} from '../src/app/stories/bunny-stream';

/**
 * "Download my data" (M2 plan PR 12; Art 15, Art 20) through api-user's real AppModule and a real
 * SurrealDB. The database is the behaviour: Ann has data of every kind a person can have, and the
 * file must hold all of it (checked against what the database holds, read as the migrator) and
 * nothing of Bob's, though Bob's data touches hers (he hearts her story, she hearts his). Clerk's
 * Backend API is an in-memory stand-in answering as Clerk does; media links are signed with test
 * keys. Every answer is checked against api-user.yaml.
 */
class FakeStream implements BunnyStream {
  async createVideo() {
    return randomUUID();
  }
  async video() {
    return null;
  }
  async deleteVideo() {
    // nothing to delete here
  }
  sign(videoId: string, now?: number) {
    return signUpload('42', 'library-key', videoId, now);
  }
}

/** Clerk's `GET /users/{id}` as Clerk answers it, for whoever is asked about. */
class FakeClerk implements ClerkBackend {
  failing = false;
  readonly asked: string[] = [];
  async deleteUser() {
    throw new Error('not in these tests');
  }
  async webhookKey() {
    return null;
  }
  async getUser(id: string) {
    this.asked.push(id);
    if (this.failing) throw new Error('Clerk user read answered 503');
    const who = id.slice('user_'.length);
    return clerkProfile(id, {
      id,
      first_name: `First-${who}`,
      last_name: null,
      username: null,
      primary_email_address_id: 'idn_1',
      email_addresses: [
        {
          id: 'idn_1',
          email_address: `${who}@example.org`,
          verification: { status: 'verified' },
        },
      ],
      phone_numbers: [],
      external_accounts: [
        { provider: 'oauth_google', email_address: `${who}@example.org` },
      ],
      has_image: false,
      image_url: 'https://img.clerk.com/default',
      two_factor_enabled: false,
      private_metadata: { secret: 'PRIVATE-META-q8' },
      created_at: Date.UTC(2026, 9, 1),
      last_sign_in_at: Date.UTC(2026, 9, 30),
      last_active_at: Date.UTC(2026, 9, 31),
    });
  }
}

const HOUR_MS = 60 * 60 * 1000;

describe('download my data', () => {
  const contract = new Contract('api-user.yaml');
  const clerkApi = new FakeClerk();
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;

  async function call(
    method: string,
    path: string,
    who: string,
    init: RequestInit = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      ...init,
      method,
      headers: {
        authorization: `Bearer ${clerk.token(`user_${who}`)}`,
        ...(init.headers as Record<string, string>),
      },
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }

  /** A draft through the API itself, so it leaves an idempotency key as a real one does. */
  async function createThroughApi(who: string, title: string) {
    const key = `export-key-${who}-${++keySeq}-${'x'.repeat(16)}`;
    const res = await call('POST', '/v1/stories', who, {
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        title,
        primaryFormat: 'written',
        tagSlugs: ['healing'],
        body: `${title}${STORY_TEXT_PADDING}`,
      }),
    });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, key };
  }

  /**
   * A moderator's decision on a story, as moderation will record it (M3): the status set as a
   * system user would (as my-stories does), the published copy and the review by api-admin.
   */
  async function decide(
    id: string,
    decision: 'approve' | 'request_changes' | 'reject',
    feedback?: string,
  ) {
    if (decision === 'approve') {
      await approve(admin, id);
    } else {
      await run(
        migrator,
        `UPDATE type::record('story', $id) SET status = $status, rejectionFeedback = $feedback`,
        {
          id,
          feedback,
          status: decision === 'reject' ? 'rejected' : 'changes_requested',
        },
      );
      await run(
        admin,
        `LET $s = type::record('story', $id);
         CREATE moderationReview CONTENT {
           story: $s, moderator: user:modq7, decision: $decision,
           feedbackToSubmitter: $feedback, storyVersion: (SELECT VALUE version FROM ONLY $s)
         };`,
        { id, decision, feedback },
      );
    }
  }

  /** Everything the database holds of a person, read as the migrator: the ground truth. */
  const truth = (who: string) =>
    rows<Record<string, unknown[]>>(
      migrator,
      `LET $u = type::record('user', $who);
       RETURN {
         stories: (SELECT VALUE record::id(id) FROM story WHERE submitter = $u),
         reviews: (SELECT VALUE decision FROM moderationReview WHERE story.submitter = $u),
         consents: (SELECT VALUE record::id(id) FROM consent WHERE subject = $u),
         hearts: (SELECT VALUE record::id(story) FROM favourite WHERE person = $u),
         submissions: (SELECT VALUE at FROM submissionLog WHERE person = $u),
         uploads: (SELECT VALUE record::id(id) FROM uploadGrant WHERE person = $u),
         keys: (SELECT VALUE record::id(id)[2] FROM idempotencyKey WHERE record::id(id)[1] = $u)
       }`,
      { who },
    ).then((r) => r.at(-1) as Record<string, unknown[]>);

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    apiUser = await t.service('api_user');
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
      .overrideProvider(BUNNY_STREAM)
      .useValue(new FakeStream())
      .overrideProvider(CLERK_BACKEND)
      .useValue(clerkApi)
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
    await createPeople(t, { modq7: 'user_modq7' });
    await run(
      admin,
      `CREATE tag:healing SET name = 'Healing', category = 'theme'`,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('holds everything of mine, in every status and table, and nothing of anyone else’s', async () => {
    await createPeople(t, { ann: 'user_ann', zqx: 'user_zqx' });
    const ann = await t.person('user_ann');
    const zed = await t.person('user_zqx');
    await grantAll(ann);
    await grantAll(zed);
    // Ann: an admin's limits for her alone. Zed: trusted, with limits of his own.
    await run(
      migrator,
      `CREATE submitterLimits:ann SET user = user:ann, trusted = true, uploadRequestsPerHour = 20;
       CREATE submitterLimits:zqx SET user = user:zqx, trusted = true, uploadRequestsPerHour = 33;`,
    );

    // Ann's stories: a draft with a picture, one waiting, one sent back with feedback, one
    // rejected, one published (and hearted by Zed), and a video draft with its upload.
    // A picture comes only through an upload grant (api-user's login), in the story's folder.
    const picture = async (
      id: string,
      width: number,
      height: number,
      alt?: string,
    ) => {
      const [version] = await rows<number>(
        migrator,
        `SELECT VALUE version FROM type::record('story', $id)`,
        { id },
      );
      expect(
        await grantImage(apiUser, {
          story: id,
          person: 'ann',
          version,
          width,
          height,
          alt: alt ?? null,
        }),
      ).toMatchObject({ ok: true });
      return `stories/${id}/${'a'.repeat(32)}.webp`;
    };
    const annDraft = await createThroughApi('ann', 'Ann draft');
    await run(ann, `UPDATE type::record('story', $id) SET bylineName = 'Ann'`, {
      id: annDraft.id,
    });
    const draftPicture = await picture(annDraft.id, 800, 600, 'A sunrise');
    const annWaiting = await createThroughApi('ann', 'Ann waiting');
    await submit(ann, annWaiting.id);
    const annBack = await createThroughApi('ann', 'Ann sent back');
    await submit(ann, annBack.id);
    await decide(annBack.id, 'request_changes', 'Please say a little more.');
    const annNo = await createThroughApi('ann', 'Ann rejected');
    await submit(ann, annNo.id);
    await decide(annNo.id, 'reject', 'Not for this site, sorry.');
    const annLive = await createThroughApi('ann', 'Ann live');
    const livePicture = await picture(annLive.id, 640, 480);
    await submit(ann, annLive.id);
    await processed(await t.service('workflow'), annLive.id);
    await decide(annLive.id, 'approve');
    const annVideo = randomUUID();
    await draft(ann, 'ann_video', { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video: annVideo,
        story: 'ann_video',
        person: 'ann',
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    await processed(await t.service('workflow'), 'ann_video');

    // Zed's stories: a secret draft, a video and a published one, which Ann hearts; he hearts hers.
    const ZED_TEXT = 'ZQXSECRET words nobody else may read';
    const zedDraft = await createThroughApi('zqx', ZED_TEXT);
    const zedVideo = randomUUID();
    await draft(zed, 'zqx_video', { primaryFormat: 'video', body: undefined });
    await grantUpload(apiUser, {
      video: zedVideo,
      story: 'zqx_video',
      person: 'zqx',
      version: 1,
    });
    const zedLive = await createThroughApi('zqx', 'Shared story');
    await submit(zed, zedLive.id);
    await decide(zedLive.id, 'approve');
    await run(
      ann,
      `CREATE favourite SET person = $auth, story = type::record('story', $id)`,
      {
        id: zedLive.id,
      },
    );
    await run(
      zed,
      `CREATE favourite SET person = $auth, story = type::record('story', $id)`,
      {
        id: annLive.id,
      },
    );

    const before = Date.now();
    const res = await call('GET', '/v1/account/export', 'ann');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="he-is-real-my-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const file = res.body;
    const held = await truth('ann');

    // Complete: every row the database holds of Ann, in each table.
    expect(file.account).toMatchObject({ id: 'ann', role: 'User' });
    expect(file.signIn).toMatchObject({
      clerkUserId: 'user_ann',
      firstName: 'First-ann',
      emailAddresses: [
        { emailAddress: 'ann@example.org', primary: true, verified: true },
      ],
      connectedAccounts: [
        { provider: 'oauth_google', emailAddress: 'ann@example.org' },
      ],
      profileImageUrl: null,
    });
    expect(clerkApi.asked).toEqual(['user_ann']);
    expect(file.stories.map((s: { id: string }) => s.id).sort()).toEqual(
      [...held['stories']].sort(),
    );
    expect(
      Object.fromEntries(
        file.stories.map((s: { id: string; status: string }) => [
          s.id,
          s.status,
        ]),
      ),
    ).toEqual({
      [annDraft.id]: 'draft',
      [annWaiting.id]: 'pending',
      [annBack.id]: 'changes_requested',
      [annNo.id]: 'rejected',
      [annLive.id]: 'approved',
      ann_video: 'draft',
    });
    expect(file.consents.map((c: { id: string }) => c.id).sort()).toEqual(
      [...held['consents']].sort(),
    );
    expect(file.favourites.map((f: { storyId: string }) => f.storyId)).toEqual(
      held['hearts'],
    );
    expect(file.submissions).toHaveLength(held['submissions'].length);
    expect(held['submissions']).toHaveLength(4);
    expect(
      file.uploads.map(
        (u: { bunnyVideoId: string | null; imagePath: string | null }) =>
          u.bunnyVideoId ?? u.imagePath,
      ),
    ).toEqual(held['uploads']);
    // Ann's two pictures are uploads too, by their path.
    expect(
      file.uploads
        .filter((u: { format: string }) => u.format === 'image')
        .map((u: { imagePath: string }) => u.imagePath)
        .sort(),
    ).toEqual([draftPicture, livePicture].sort());
    expect(file.requestKeys.map((k: { key: string }) => k.key).sort()).toEqual(
      [...held['keys']].sort(),
    );
    expect(held['keys']).toHaveLength(5);
    const reviews = file.stories.flatMap(
      (s: { moderation: { decision: string }[] }) =>
        s.moderation.map((m) => m.decision),
    );
    expect(reviews.sort()).toEqual([...held['reviews']].sort());

    // Each part as the person sees it.
    const story = (id: string) =>
      file.stories.find((s: { id: string }) => s.id === id);
    expect(story(annDraft.id)).toMatchObject({
      title: 'Ann draft',
      body: `Ann draft${STORY_TEXT_PADDING}`,
      bylineName: 'Ann',
      tags: [{ slug: 'healing', name: 'Healing' }],
      onSiteNow: false,
      image: {
        width: 800,
        height: 600,
        alt: 'A sunrise',
        // The database keeps every picture in its own story's folder, so the person's own
        // picture is signed for them, published or not.
        url: expect.stringContaining(`/${draftPicture}?token=HS256-`),
      },
    });
    expect(story(annDraft.id).draftExpiresAt).not.toBeNull();
    expect(story(annBack.id)).toMatchObject({
      rejectionFeedback: 'Please say a little more.',
      moderation: [
        {
          decision: 'request_changes',
          feedbackToSubmitter: 'Please say a little more.',
          storyVersion: expect.any(Number),
          decidedAt: expect.any(String),
        },
      ],
    });
    expect(story(annLive.id)).toMatchObject({
      onSiteNow: true,
      publishedAt: expect.any(String),
      moderation: [{ decision: 'approve', feedbackToSubmitter: null }],
      image: {
        width: 640,
        height: 480,
        alt: null,
        url: expect.stringMatching(
          new RegExp(
            `^https://images-test\\.b-cdn\\.net/${livePicture}\\?token=HS256-`,
          ),
        ),
      },
    });
    // Media as links and ids, never bytes: the player link expires in an hour.
    const [clip] = story('ann_video').media;
    expect(clip).toMatchObject({
      format: 'video',
      bunnyVideoId: annVideo,
      playbackUrl: expect.stringContaining(
        `https://player.mediadelivery.net/embed/42/${annVideo}?token=`,
      ),
      processing: 'ready',
    });
    const expires =
      Number(new URL(clip.playbackUrl).searchParams.get('expires')) * 1000;
    expect(expires).toBe(new Date(file.about.linksExpireAt).getTime());
    expect(expires - before).toBeGreaterThan(HOUR_MS - 60_000);
    expect(expires - before).toBeLessThanOrEqual(HOUR_MS + 60_000);
    expect(
      file.uploads.find((u: { format: string }) => u.format === 'video'),
    ).toMatchObject({
      imagePath: null,
      storyId: 'ann_video',
      format: 'video',
      contentType: 'video/mp4',
      sizeBytes: 1_000_000,
    });
    // The words of each box ticked.
    expect(
      file.consents.every(
        (c: { statement: unknown }) => typeof c.statement === 'string',
      ),
    ).toBe(true);
    expect(file.consents[0]).toMatchObject({
      event: 'granted',
      privacyPolicyVersion: 'v1',
    });
    expect(file.favourites).toEqual([
      {
        storyId: zedLive.id,
        heartedAt: expect.any(String),
        publicPath: expect.stringMatching(/^\/stories\//),
      },
    ]);
    expect(file.limits).toMatchObject({
      trusted: true,
      overrides: { uploadRequestsPerHour: 20 },
      effective: { uploadRequestsPerHour: 20, openDraftsMax: null },
    });
    expect(Object.keys(file.about.sections).sort()).toEqual(
      Object.keys(file)
        .filter((k) => k !== 'about')
        .sort(),
    );

    // Nothing of anyone else's: not Zed, not his words, ids, video, keys or hearts; not who moderated.
    const zedHeld = await truth('zqx');
    const zedOnly = [
      'zqx',
      ZED_TEXT,
      zedDraft.id,
      zedVideo,
      'zqx_video',
      ...zedHeld['consents'],
      ...(zedHeld['keys'] as string[]),
      'modq7',
      'PRIVATE-META-q8',
    ].map(String);
    for (const needle of zedOnly) {
      expect([
        needle,
        res.text.toLowerCase().includes(needle.toLowerCase()),
      ]).toEqual([needle, false]);
    }
    // Zed's own copy has his heart on Ann's story, and none of her stories.
    const theirs = (await call('GET', '/v1/account/export', 'zqx')).body;
    expect(
      theirs.favourites.map((f: { storyId: string }) => f.storyId),
    ).toEqual([annLive.id]);
    expect(theirs.stories.map((s: { id: string }) => s.id).sort()).toEqual(
      [...zedHeld['stories']].sort(),
    );
    expect(theirs.limits.overrides.uploadRequestsPerHour).toBe(33);
  });

  it('is all or nothing: when Clerk can’t answer, 503 and no file', async () => {
    await createPeople(t, { cy: 'user_cy' });
    clerkApi.failing = true;
    try {
      const res = await call('GET', '/v1/account/export', 'cy');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'export_unavailable' });
      expect(res.headers.get('content-disposition')).toBeNull();
    } finally {
      clerkApi.failing = false;
    }
    // Someone with nothing but an account gets the empty parts, explained.
    const { body } = await call('GET', '/v1/account/export', 'cy');
    expect(body).toMatchObject({
      account: { id: 'cy' },
      stories: [],
      consents: [],
      favourites: [],
      submissions: [],
      uploads: [],
      requestKeys: [],
      limits: { trusted: false, overrides: null, overridesChangedAt: null },
    });
  });
});
