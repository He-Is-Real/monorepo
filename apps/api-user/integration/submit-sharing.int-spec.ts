import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { ConsentLedger } from '@heisreal/consent';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  createPeople,
  grantAll,
  publishDpa,
  publishForm,
  rows,
  run,
  STORY_TEXT_PADDING,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { RecordId, type Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { StoryStore } from '../src/app/stories/story-store';

/**
 * O4: sharing beyond heisreal.today, ticked on Review, is part of SubmitStory. The grant and the
 * submission commit in one transaction with the submission's Idempotency-Key, so either both are
 * written or neither is, and a replay grants nothing again (the database is the behaviour here).
 * Its own database: the last test publishes a newer social sharing form.
 */
describe('submitting with sharing beyond heisreal.today', () => {
  const contract = new Contract('api-user.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;

  const key = () => `share-key-${++keySeq}-${'x'.repeat(16)}`;
  const SHARE = { formVersion: 'v1', privacyPolicyVersion: 'v1' };

  async function call(
    method: string,
    path: string,
    who: string,
    {
      body,
      headers = {},
    }: { body?: unknown; headers?: Record<string, string> },
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
  /** A signed-up person with a draft ready to submit; its id. */
  async function draft(who: string): Promise<string> {
    await createPeople(t, { [who]: `user_${who}` });
    await grantAll(await t.person(`user_${who}`));
    const res = await call('POST', '/v1/stories', who, {
      body: {
        title: 'Further afield',
        primaryFormat: 'written',
        body: `My story${STORY_TEXT_PADDING}`,
        tagSlugs: ['healing'],
      },
      headers: { 'idempotency-key': key() },
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }
  const submit = (
    who: string,
    id: string,
    version: number,
    k: string,
    body?: unknown,
  ) =>
    call('POST', `/v1/stories/${id}/submit`, who, {
      body,
      headers: { 'if-match': `"${version}"`, 'idempotency-key': k },
    });
  /** What the database holds: the story's status and its share_socials events. */
  const stateOf = async (id: string) => {
    const [story] = await rows(
      migrator,
      `SELECT status, version FROM type::record('story', $id)`,
      { id },
    );
    const events = await rows(
      migrator,
      `SELECT event, mechanism, evidenceVersion, record::id(form) AS form,
         record::id(dpaVersion) AS dpa
       FROM consent WHERE type = 'share_socials' AND story = type::record('story', $id)`,
      { id },
    );
    return { status: story?.['status'], events };
  };

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
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
    await run(
      await t.service('api_admin'),
      `CREATE tag:healing SET name = 'Healing', category = 'theme';`,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('records the story’s sharing with the submission, once, and a replay grants nothing again', async () => {
    const id = await draft('ann');
    const k = key();
    const sent = await submit('ann', id, 1, k, { shareBeyondSite: SHARE });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ id, version: 2 });
    expect(await stateOf(id)).toEqual({
      status: 'pending',
      events: [
        {
          event: 'granted',
          mechanism: 'web_form_submission',
          evidenceVersion: 5,
          form: 'v1',
          dpa: 'v1',
        },
      ],
    });
    const mine = await call('GET', `/v1/account/stories/${id}`, 'ann', {});
    expect(mine.body.sharing).toMatchObject({ granted: true, counts: true });

    // The lost answer's replay: the same answer, and still one grant.
    const again = await submit('ann', id, 1, k, { shareBeyondSite: SHARE });
    expect([again.status, again.body]).toEqual([200, { id, version: 2 }]);
    expect((await stateOf(id)).events).toHaveLength(1);
    // The same key without the sharing is another request.
    const other = await submit('ann', id, 1, k);
    expect([other.status, other.body.code]).toEqual([
      422,
      'idempotency_key_reused',
    ]);
    expect((await stateOf(id)).events).toHaveLength(1);
  });

  it('without the box, submitting leaves the story’s sharing as it is', async () => {
    const id = await draft('bob');
    expect((await submit('bob', id, 1, key())).status).toBe(200);
    expect(await stateOf(id)).toEqual({ status: 'pending', events: [] });
  });

  it('a refused grant submits nothing, and a refused submission grants nothing', async () => {
    const id = await draft('cat');
    // The privacy policy shown isn't the one in force: 409, the story stays a draft.
    const stale = await submit('cat', id, 1, key(), {
      shareBeyondSite: { formVersion: 'v1', privacyPolicyVersion: 'v9' },
    });
    expect([stale.status, stale.body.code]).toEqual([
      409,
      'legal_document_not_in_force',
    ]);
    expect(await stateOf(id)).toEqual({ status: 'draft', events: [] });
    // Malformed: 400.
    const bad = await submit('cat', id, 1, key(), { shareBeyondSite: true });
    expect([bad.status, bad.body.code]).toEqual([400, 'validation_failed']);
    // The submission refused (a stale version): no grant either.
    const old = await submit('cat', id, 7, key(), { shareBeyondSite: SHARE });
    expect(old.status).toBe(412);
    expect(await stateOf(id)).toEqual({ status: 'draft', events: [] });
  });

  it('in the transaction itself: the submission failing at commit takes the grant with it, and the grant failing takes the submission', async () => {
    const id = await draft('dan');
    const session = await t.person('user_dan');
    const ledger = new ConsentLedger();
    const scope = () => ({
      scope: {
        service: 'api-user' as const,
        owner: new RecordId('user', 'dan'),
        key: key(),
      },
      requestHash: key(),
    });

    // Another tab saves the story after the checks, before the commit: the submission's own
    // version check fails in the transaction, after the grant's statements ran.
    await expect(
      new StoryStore(session).submit(id, 1, scope(), undefined, async () => {
        const grant = await ledger.storySharingGrant(session, {
          ...SHARE,
          storyId: id,
        });
        await run(
          session,
          `UPDATE type::record('story', $id) SET description = 'Saved in another tab'`,
          { id },
        );
        return grant;
      }),
    ).rejects.toMatchObject({ status: 412 });
    expect(await stateOf(id)).toEqual({ status: 'draft', events: [] });

    // A newer social sharing form is published after the checks: the grant's own check fails in
    // the transaction, and the submission isn't written.
    await expect(
      new StoryStore(session).submit(id, 2, scope(), undefined, async () => {
        const grant = await ledger.storySharingGrant(session, {
          ...SHARE,
          storyId: id,
        });
        await publishForm(t, 'social', 'v2');
        return grant;
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'form_version_not_in_force' },
    });
    expect(await stateOf(id)).toEqual({ status: 'draft', events: [] });
  });
});
