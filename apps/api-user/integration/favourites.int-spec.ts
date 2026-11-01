import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  agree,
  approve,
  buildWorld,
  createPeople,
  draft,
  run,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { AppModule } from '../src/app/app.module';

/**
 * Hearts (M2) through api-user's real AppModule on SurrealDB 3.2.4, as web's browser calls them:
 * heart and un-heart a story, the "My favourites" list, and the "which of these are my
 * favourites?" lookup that colours a page of cards. Every answer is checked against
 * api-user.yaml, like web's e2e stub of these routes. Who may read and write which rows is the
 * database's (libs/database favourites.int-spec.ts); this checks the routes keep to it.
 */
describe('hearts: /v1/account/favourites', () => {
  const contract = new Contract('api-user.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let app: INestApplication;
  let url: string;

  const as = (clerkUserId: string) => ({
    authorization: `Bearer ${clerk.token(clerkUserId)}`,
  });
  const call = async (
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${url}${path}`, { method, headers });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    return res;
  };
  const heart = (who: string, story: string) =>
    call('PUT', `/v1/account/favourites/${story}`, as(who));
  const unheart = (who: string, story: string) =>
    call('DELETE', `/v1/account/favourites/${story}`, as(who));
  const listed = async (who: string, query = '') => {
    const res = await call('GET', `/v1/account/favourites${query}`, as(who));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string }[];
      nextCursor: string | null;
    };
    return { ids: body.data.map((s) => s.id), nextCursor: body.nextCursor };
  };
  const among = (who: string, ids: string[]) =>
    listed(who, `?${ids.map((id) => `storyId=${id}`).join('&')}`);

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    const world = await buildWorld(t); // bob_live is public; the rest aren't
    for (const id of ['bob_two', 'bob_three']) {
      await draft(world.bob, id);
      await submit(world.bob, id);
      await approve(world.admin, id);
    }
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
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('hearts a public story once, lists it as a card, and removes it', async () => {
    expect((await heart('user_ann', 'bob_live')).status).toBe(204);
    expect((await heart('user_ann', 'bob_live')).status).toBe(204); // idempotent
    const res = await call('GET', '/v1/account/favourites', as('user_ann'));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      data: [{ id: 'bob_live', slug: 'bob_live', title: 'Story bob_live' }],
      nextCursor: null,
    });

    expect((await unheart('user_ann', 'bob_live')).status).toBe(204);
    expect((await unheart('user_ann', 'bob_live')).status).toBe(204);
    expect((await listed('user_ann')).ids).toEqual([]);
  });

  it('nobody sees or removes anyone else’s hearts, not even the story’s owner', async () => {
    await heart('user_ann', 'bob_two');
    expect((await listed('user_bob')).ids).toEqual([]);
    expect((await among('user_bob', ['bob_two'])).ids).toEqual([]);
    expect((await unheart('user_bob', 'bob_two')).status).toBe(204);
    expect((await listed('user_ann')).ids).toEqual(['bob_two']);
    await unheart('user_ann', 'bob_two');
  });

  it('only a story that is public now can be hearted', async () => {
    for (const story of ['bob_draft', 'bob_pending', 'ann_draft', 'no_such']) {
      const res = await heart('user_ann', story);
      expect(res.status, story).toBe(404);
    }
    expect((await heart('user_ann', 'not a valid id!')).status).toBe(404);
    expect((await listed('user_ann')).ids).toEqual([]);
  });

  it('lists newest heart first, a page at a time', async () => {
    for (const story of ['bob_live', 'bob_two', 'bob_three'])
      await heart('user_ann', story);
    const first = await listed('user_ann', '?limit=2');
    expect(first.ids).toEqual(['bob_three', 'bob_two']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listed(
      'user_ann',
      `?limit=2&cursor=${first.nextCursor}`,
    );
    expect(second).toEqual({ ids: ['bob_live'], nextCursor: null });
  });

  it('answers which of a page of cards are hearted, and only public ones', async () => {
    expect(
      (await among('user_ann', ['bob_two', 'bob_draft', 'ann_draft', 'zzz']))
        .ids,
    ).toEqual(['bob_two']);
    // A story withdrawn after the heart drops out of the list and the lookup (C15).
    await run(
      await t.person('user_bob'),
      `BEGIN TRANSACTION;
       UPDATE story:bob_two SET status = 'withdrawn';
       DELETE publicStory:bob_two;
       COMMIT TRANSACTION;`,
    );
    expect((await listed('user_ann')).ids).toEqual(['bob_three', 'bob_live']);
    expect(
      (await among('user_ann', ['bob_two', 'bob_three', 'bob_live'])).ids,
    ).toEqual(['bob_three', 'bob_live']);
    // Its heart is still Ann's to remove.
    expect((await unheart('user_ann', 'bob_two')).status).toBe(204);
  });

  it('answers 304 to its own ETag, and a changed list gets a new one', async () => {
    const first = await call('GET', '/v1/account/favourites', as('user_ann'));
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/"/);
    const again = await call('GET', '/v1/account/favourites', {
      ...as('user_ann'),
      'if-none-match': etag,
    });
    expect(again.status).toBe(304);
    await unheart('user_ann', 'bob_live');
    const changed = await call('GET', '/v1/account/favourites', {
      ...as('user_ann'),
      'if-none-match': etag,
    });
    expect(changed.status).toBe(200);
  });

  it('a heart waits for the latest terms of use (plan 4e), and removing one never does', async () => {
    await createPeople(t, { cy: 'user_cy' });
    const refused = await heart('user_cy', 'bob_three');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: 'terms_agreement_required',
    });
    expect((await listed('user_cy')).ids).toEqual([]);
    expect((await unheart('user_cy', 'bob_three')).status).toBe(204);

    await agree(await t.person('user_cy'), 'termsOfUse');
    expect((await heart('user_cy', 'bob_three')).status).toBe(204);
    expect((await listed('user_cy')).ids).toEqual(['bob_three']);
  });

  it('refuses malformed queries as 400 problems, never echoing the value', async () => {
    for (const query of [
      '?limit=0',
      '?limit=51',
      '?cursor=not-a-cursor',
      `?cursor=${Buffer.from(JSON.stringify({ v: 1, k: ['2026-02-31T00:00:00Z', 'x'] })).toString('base64url')}`,
      '?storyId=a&limit=5',
      `?${Array.from({ length: 51 }, (_, i) => `storyId=s${i}`).join('&')}`,
      '?storyId=bad%20id',
      '?sort=oldest',
    ]) {
      const res = await call(
        'GET',
        `/v1/account/favourites${query}`,
        as('user_ann'),
      );
      expect(res.status, query).toBe(400);
      expect(await res.text(), query).not.toContain('bad id');
    }
  });

  it('refuses a missing token on every route', async () => {
    expect((await call('GET', '/v1/account/favourites')).status).toBe(401);
    expect((await call('PUT', '/v1/account/favourites/bob_live')).status).toBe(
      401,
    );
    expect(
      (await call('DELETE', '/v1/account/favourites/bob_live')).status,
    ).toBe(401);
  });
});
