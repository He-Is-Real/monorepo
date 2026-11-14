import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type Request,
  test,
  type TestInfo,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES, SCREENSHOT_DEVICES } from './devices';
import {
  countFetches,
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
  fetchesTakenIn,
} from './helpers';
import {
  fixtureToken,
  STUB_URL,
  STUB_USER_URL,
  WEB_SIGNED_IN_URL,
} from './servers';

// Hearts (M2): a person's own favourites, private to them, filled in by the browser from
// api-user (D83) after web's server renders the same page for everyone. Signed in, against the
// stub api-user (stub-api-user.mjs, checked against the contract in contract.e2e.ts); each test
// has its own session there, so its hearts are its own. The behaviour runs on one phone and one
// desktop; the layout (44 px targets, no sideways scroll, light and dark) on every device.

const FAVOURITES = '/v1/account/favourites';
const HEART_PAGE = '/stories?theme=heart_test';
/** Browse with "Favourites only" on (Joel, 2026-11-14), signed in. */
const FAVOURITES_ONLY = `${WEB_SIGNED_IN_URL}/stories?favourites=1`;
const DEVICE_HEARTS_KEY = 'heisreal:device-hearts';

/** This test's own session at the stub api-user. */
function sessionFor(info: TestInfo, name: string) {
  // Its own for every test, device and repeat: the stub keeps hearts per session.
  return `${name}-${info.project.name}-r${info.repeatEachIndex}-t${info.retry}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

/** Hearts stories for this session straight at the stub, as an earlier visit would have. */
async function heartAtStub(
  request: APIRequestContext,
  session: string,
  ids: string[],
) {
  for (const id of ids) {
    const res = await request.put(`${STUB_USER_URL}${FAVOURITES}/${id}`, {
      headers: { authorization: `Bearer ${fixtureToken(session)}` },
    });
    expect(res.status()).toBe(204);
  }
}

interface Box {
  x: number;
  top: number;
  bottom: number;
}

/** Each card's column (left edge) and its top and bottom, from the top of the list. */
async function masonryBoxes(list: Locator): Promise<Box[]> {
  return list.locator('> li > article').evaluateAll((cards) => {
    const top = cards[0]?.closest('ul')?.getBoundingClientRect().top ?? 0;
    return cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), top: r.top - top, bottom: r.bottom - top };
    });
  });
}

/**
 * Browse's masonry: the column count for the width, and in each column a card starting one
 * gap (24 px, rounded up to the grid's 4 px rows) below the one above it, whatever the heights
 * beside it.
 */
function expectStaggered(boxes: Box[], width: number) {
  const columns = new Set(boxes.map((b) => b.x));
  expect(columns.size).toBe(width >= 1024 ? 3 : width >= 640 ? 2 : 1);
  for (const x of columns) {
    const column = boxes.filter((b) => b.x === x).sort((a, b) => a.top - b.top);
    for (let i = 1; i < column.length; i++) {
      const gap = column[i].top - column[i - 1].bottom;
      expect(gap).toBeGreaterThanOrEqual(23);
      expect(gap).toBeLessThanOrEqual(29);
    }
  }
}

const isLookup = (r: Request) =>
  r.method() === 'GET' &&
  r.url().startsWith(`${STUB_USER_URL}${FAVOURITES}?storyId=`);
const isCommand = (method: 'PUT' | 'DELETE', id: string) => (r: Request) =>
  r.method() === method && r.url() === `${STUB_USER_URL}${FAVOURITES}/${id}`;

const heartId = (project: string) => `heart_test_${project.replace('-', '_')}`;

/** The hearts this browser keeps (local storage), newest first. */
async function deviceHearts(page: Page): Promise<string[]> {
  const raw = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    DEVICE_HEARTS_KEY,
  );
  return raw === null
    ? []
    : (JSON.parse(raw).hearts as { id: string }[]).map((h) => h.id);
}

/** Hearts this browser already keeps, put there before any page loads (once). */
async function seedDeviceHearts(
  page: Page,
  hearts: { id: string; at?: number }[],
) {
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem('e2e-seeded')) return;
      window.localStorage.setItem('e2e-seeded', '1');
      window.localStorage.setItem(key, value);
    },
    [
      DEVICE_HEARTS_KEY,
      JSON.stringify({
        v: 1,
        hearts: hearts.map((h) => ({ id: h.id, at: h.at ?? Date.now() })),
      }),
    ] as const,
  );
}

/**
 * A public story of this test's own (stub-api.mjs, POST /__test/story), so hiding it can't touch
 * any other test or repeat (no shared state). Returns its slug; its id is the slug with `_`.
 */
async function ownStory(
  request: APIRequestContext,
  info: TestInfo,
  name: string,
): Promise<string> {
  const slug = `heart-tmp-${sessionFor(info, name)}`;
  const res = await request.post(`${STUB_URL}/__test/story?slug=${slug}`);
  expect(res.status()).toBe(204);
  return slug;
}

/**
 * Holds the story's first save (PUT) until `release()`, then passes it on (or, with `fail`,
 * answers 503); later saves go straight on. `seen` resolves when the first arrives.
 */
async function holdPut(
  page: Page,
  id: string,
  { fail = false }: { fail?: boolean } = {},
) {
  let heldOnce = false;
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let saw = () => undefined as void;
  const seen = new Promise<void>((resolve) => (saw = resolve));
  await page.route(`${STUB_USER_URL}${FAVOURITES}/${id}`, async (route) => {
    if (route.request().method() !== 'PUT' || heldOnce) return route.fallback();
    heldOnce = true;
    saw();
    await held;
    // The first save: on to the stub, or (fail) a 503 from api-user.
    if (!fail) return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      headers: {
        'access-control-allow-origin': new URL(WEB_SIGNED_IN_URL).origin,
      },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Service unavailable',
        status: 503,
      }),
    });
  });
  return { seen, release: () => release() };
}

/**
 * Holds the page's first account check (`GET /v1/account`, account-bootstrap.ts) until
 * `release()`, then passes it on to the stub, which answers as the session stands by then; later
 * checks go straight on.
 */
async function holdAccountCheck(page: Page) {
  let heldOnce = false;
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${STUB_USER_URL}/v1/account`, async (route) => {
    if (route.request().method() !== 'GET' || heldOnce) return route.fallback();
    heldOnce = true;
    await held;
    await route.fallback();
  });
  return { release: () => release() };
}

/** Counts the page's requests that match, from now on. */
function countRequests(page: Page, match: (r: Request) => boolean) {
  let n = 0;
  page.on('request', (r) => {
    if (match(r)) n += 1;
  });
  return () => n;
}

const cardHeart = (page: Page, title: string) =>
  page.getByRole('button', { name: `Favourite: ${title}` });

test.describe('hearts', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('a heart fills at once, stays after a reload, is on the story page and in Favourites only, and comes off there', async ({
    page,
  }, info) => {
    const project = info.project.name;
    await useSession(page, sessionFor(info, 'hearts'));
    const id = `heart_test_${project.replace('-', '_')}`;
    const title = `Heart test story (${project})`;
    const lookups: Request[] = [];
    page.on('request', (r) => {
      if (isLookup(r)) lookups.push(r);
    });

    const looked = page.waitForResponse((r) => isLookup(r.request()));
    await page.goto(`${WEB_SIGNED_IN_URL}${HEART_PAGE}`);
    expect((await looked).status()).toBe(200);
    const heart = cardHeart(page, title);
    await expect(heart).toHaveAttribute('data-heart-state', 'off');
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    // One request asked about every card on the page.
    const asked = new URL(lookups[0].url()).searchParams.getAll('storyId');
    expect(asked).toContain(id);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(lookups).toHaveLength(1);

    const put = page.waitForResponse((r) => isCommand('PUT', id)(r.request()));
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    expect((await put).status()).toBe(204);

    await page.reload();
    await expect(cardHeart(page, title)).toHaveAttribute(
      'data-heart-state',
      'on',
    );

    await page.goto(`${WEB_SIGNED_IN_URL}/stories/heart-test-${project}`);
    const storyHeart = page.getByRole('button', {
      name: 'Favourite',
      exact: true,
    });
    await expect(storyHeart).toHaveAttribute('aria-pressed', 'true');

    // Favourites only, on browse (Joel, 2026-11-14): the menu has no My favourites any more.
    const account = page.getByRole('button', { name: /^Account: / });
    await expect(account).toBeVisible();
    await account.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('link', { name: 'My favourites' })).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    const only = page.getByRole('switch', { name: 'Favourites only' });
    await expect(only).not.toBeChecked();
    await expect(page.getByRole('search', { name: 'Stories' })).toBeVisible();
    await only.click();
    await expect(only).toBeChecked();
    await expect(page).toHaveURL(FAVOURITES_ONLY);
    // Only the hearted story; the filters stay (they filter the favourites).
    await expect(page.locator('main article h2')).toHaveText([title]);
    await expect(page.getByRole('search', { name: 'Stories' })).toBeVisible();
    const listed = cardHeart(page, title);
    await expect(listed).toHaveAttribute('aria-pressed', 'true');
    const del = page.waitForResponse((r) =>
      isCommand('DELETE', id)(r.request()),
    );
    await listed.click();
    // It stays on screen, empty, so a slip can be undone.
    await expect(listed).toHaveAttribute('aria-pressed', 'false');
    expect((await del).status()).toBe(204);
    // A reload keeps the switch on (it's in the address).
    await page.reload();
    await expect(only).toBeChecked();
    await expect(
      page.getByText('You haven’t hearted any stories yet.', { exact: false }),
    ).toBeVisible();
    // "Show all stories" turns it off again: every story, with the filters.
    await page.getByRole('button', { name: 'Show all stories' }).click();
    await expect(only).not.toBeChecked();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/stories`);
    await expect(page.getByRole('search', { name: 'Stories' })).toBeVisible();
    await expect(page.locator('main article').nth(1)).toBeVisible();
  });

  test('Favourites only turns off with the switch, back to browse with its filters', async ({
    page,
    request,
  }, info) => {
    const session = sessionFor(info, 'switch-off');
    await useSession(page, session);
    await heartAtStub(request, session, ['browse_05']);
    await page.goto(`${WEB_SIGNED_IN_URL}${HEART_PAGE}&favourites=1`);
    const only = page.getByRole('switch', { name: 'Favourites only' });
    await expect(only).toBeChecked();
    await expect(page.locator('main article h2')).toHaveText([
      'Browse test story 05',
    ]);
    await only.click();
    await expect(only).not.toBeChecked();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}${HEART_PAGE}`);
    // Browse as the address says (the heart_test theme's stories), with its filters.
    await expect(
      cardHeart(page, `Heart test story (${info.project.name})`),
    ).toBeVisible();
    await expect(page.getByRole('search', { name: 'Stories' })).toBeVisible();
  });

  test('a story that stops being public leaves Favourites only', async ({
    page,
    request,
  }, info) => {
    const session = sessionFor(info, 'gone');
    await useSession(page, session);
    const slug = await ownStory(request, info, 'gone');
    await heartAtStub(request, session, [
      'browse_05',
      slug.replaceAll('-', '_'),
    ]);
    await page.goto(FAVOURITES_ONLY);
    const cards = page.locator('[data-favourites] article h2');
    await expect(cards).toHaveText([
      `Heart temp story ${slug}`,
      'Browse test story 05',
    ]);

    await request.post(`${STUB_URL}/__test/hide?slug=${slug}`);
    try {
      await page.reload();
      await expect(cards).toHaveText(['Browse test story 05']);
    } finally {
      await request.post(`${STUB_URL}/__test/show?slug=${slug}`);
    }
  });

  test('signed out, a heart is kept on this device: no account, nothing sent, and it lasts', async ({
    page,
  }, info) => {
    const project = info.project.name;
    const id = heartId(project);
    const title = `Heart test story (${project})`;
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(STUB_USER_URL)) sent.push(r.url());
    });
    await page.goto(HEART_PAGE); // the signed-out site
    const heart = cardHeart(page, title);
    await expect(heart).toHaveAttribute('data-heart-state', 'off');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(HEART_PAGE); // no sign-in
    expect(await deviceHearts(page)).toEqual([id]);

    await page.reload();
    await expect(cardHeart(page, title)).toHaveAttribute(
      'data-heart-state',
      'on',
    );
    await page.goto(`/stories/heart-test-${project}`);
    await expect(
      page.getByRole('button', { name: 'Favourite', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Signed out, Favourites only lists this browser's hearts (FV-1, Joel 2026-11-14); there is
    // no My favourites link.
    await page.goto('/stories');
    await expect(page.getByRole('link', { name: 'My favourites' })).toHaveCount(
      0,
    );
    const only = page.getByRole('switch', { name: 'Favourites only' });
    await expect(only).not.toBeChecked();
    await only.click();
    await expect(only).toBeChecked();
    await expect(page).toHaveURL('/stories?favourites=1');
    await expect(page.locator('main article h2')).toHaveText([title]);
    await expect(cardHeart(page, title)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.reload();
    await expect(page.locator('main article h2')).toHaveText([title]);
    expect(sent, 'nothing reaches api-user').toEqual([]);
  });

  test('the old My favourites page is gone: /favourites and /account/favourites are not found', async ({
    request,
  }) => {
    for (const path of ['/favourites', '/account/favourites']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
  });

  test('signed out, a heart from long ago is still kept (no expiry)', async ({
    page,
  }, info) => {
    const project = info.project.name;
    const yearAgo = Date.now() - 400 * 24 * 60 * 60 * 1000;
    await seedDeviceHearts(page, [{ id: heartId(project), at: yearAgo }]);
    await page.goto(HEART_PAGE);
    await expect(
      cardHeart(page, `Heart test story (${project})`),
    ).toHaveAttribute('data-heart-state', 'on');
  });

  test('signed in, the device’s hearts are offered to the account, and Add saves them', async ({
    page,
    request,
  }, info) => {
    const session = sessionFor(info, 'offer-add');
    await useSession(page, session);
    await countFetches(page);
    // On the device: two public stories, one already in the account, one that isn't public.
    await heartAtStub(request, session, ['browse_03']);
    await seedDeviceHearts(page, [
      { id: 'browse_01' },
      { id: 'browse_02' },
      { id: 'browse_03' },
      { id: 'no_such_story' },
    ]);
    const puts = countRequests(
      page,
      (r) =>
        r.method() === 'PUT' &&
        r.url().startsWith(`${STUB_USER_URL}${FAVOURITES}/`),
    );
    // Codex, #117 round 4: nothing about the device's hearts reaches api-user before Add.
    const hearts = countRequests(page, (r) =>
      r.url().startsWith(`${STUB_USER_URL}${FAVOURITES}`),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    const prompt = page.locator('[data-device-hearts-prompt]');
    // The public ones, from the anonymous card lookup: whether in the account or not.
    await expect(prompt).toContainText(
      'Add the 3 stories you hearted on this device to your account?',
    );
    expect(hearts(), 'nothing reaches api-user before Add').toBe(0);
    expect(puts(), 'nothing is added without asking').toBe(0);

    const saved = Promise.all(
      ['browse_01', 'browse_02', 'browse_03'].map((id) =>
        page.waitForResponse((r) => isCommand('PUT', id)(r.request())),
      ),
    );
    await prompt.getByRole('button', { name: 'Add' }).click();
    for (const res of await saved) expect(res.status()).toBe(204);
    await expect(prompt).toHaveCount(0);
    expect(puts()).toBe(3);
    // The device's list stays as it is.
    expect(await deviceHearts(page)).toEqual([
      'browse_01',
      'browse_02',
      'browse_03',
      'no_such_story',
    ]);
    await page.goto(FAVOURITES_ONLY);
    await expect(page.locator('[data-favourites] article h2')).toHaveCount(3);
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Nothing left to offer: what was added from this device isn't offered again.
    const lookedUp = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.request().headers()['next-action'] !== undefined,
    );
    await page.reload();
    await lookedUp; // the anonymous card lookup for what's left (the story that isn't public)
    await fetchesTakenIn(page); // and the page has taken its answer in
    await expect(prompt).toHaveCount(0);
  });

  test('“Not now” adds nothing; the prompt asks again on the next visit', async ({
    page,
  }, info) => {
    await useSession(page, sessionFor(info, 'offer-later'));
    await seedDeviceHearts(page, [{ id: 'browse_04' }]);
    const puts = countRequests(page, isCommand('PUT', 'browse_04'));
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    const prompt = page.locator('[data-device-hearts-prompt]');
    await expect(prompt).toContainText(
      'Add the story you hearted on this device to your account?',
    );
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await expect(prompt).toHaveCount(0);
    expect(puts()).toBe(0);
    await page.reload();
    await expect(prompt).toBeVisible();
    expect(puts()).toBe(0);
  });

  // Plan 4e: the terms change while the page is open, and api-user refuses the heart. The page's
  // account check (account-bootstrap.ts) may answer before the change (terms agreed: only the
  // heart sends the person to the terms step) or after it (consent-prompts.tsx sends them there
  // too). Both are held in place here, so each runs the same way every time. Left to chance, CI
  // saw the account check move the page to the terms step just before the click (the heart was
  // gone from the page: desktop-1280) or just after it (the heart's refusal then nested the terms
  // step in its own return address, and the person ended at home: phone-320).
  for (const accountCheck of ['before', 'after'] as const)
    test(`a heart made before agreeing to changed terms stays on the device and is offered after agreeing (the account check answers ${accountCheck} the change)`, async ({
      page,
      request,
    }, info) => {
      const project = info.project.name;
      const id = `heart_test_${project.replace('-', '_')}`;
      const session = sessionFor(info, `terms-first-${accountCheck}`);
      await useSession(page, session);
      const account = await holdAccountCheck(page);
      const save = await holdPut(page, id);
      await page.goto(`${WEB_SIGNED_IN_URL}${HEART_PAGE}`);
      const heart = cardHeart(page, `Heart test story (${project})`);
      await expect(heart).toHaveAttribute('data-heart-state', 'off');
      if (accountCheck === 'before') {
        const answered = page.waitForResponse(
          (r) => r.url() === `${STUB_USER_URL}/v1/account`,
        );
        account.release();
        expect((await answered).status()).toBe(200);
      }
      await request.post(
        `${STUB_USER_URL}/__e2e/sessions/${session}/agreements`,
        {
          data: { terms: 0 },
        },
      );
      const refused = page.waitForResponse((r) =>
        isCommand('PUT', id)(r.request()),
      );
      await heart.click();
      await save.seen;
      if (accountCheck === 'after') {
        // The account check's step first; the heart's refusal arrives on it.
        account.release();
        await expect(page).toHaveURL(/\/consent\/terms\?/);
      }
      save.release();
      expect((await refused).status()).toBe(403);
      // One terms step, returning to the page the heart was on.
      await expect(page).toHaveURL(
        `${WEB_SIGNED_IN_URL}/consent/terms?redirect_url=${encodeURIComponent(HEART_PAGE)}`,
      );
      expect(await deviceHearts(page)).toEqual([id]);
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Our terms of use have changed',
        }),
      ).toBeVisible();
      await expect(page.locator('[data-redline] ins').first()).toBeVisible();
      await page
        .locator('label')
        .filter({ hasText: 'I agree to version 2 of the terms of use.' })
        .click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}${HEART_PAGE}`);
      const prompt = page.locator('[data-device-hearts-prompt]');
      await expect(prompt).toContainText(
        'Add the story you hearted on this device to your account?',
      );
      const saved = page.waitForResponse((r) =>
        isCommand('PUT', id)(r.request()),
      );
      await prompt.getByRole('button', { name: 'Add' }).click();
      expect((await saved).status()).toBe(204);
      await expect(heart).toHaveAttribute('aria-pressed', 'true');
    });

  test('Add waits for a save already on its way, and says so when that fails', async ({
    page,
  }, info) => {
    // Codex, #117 round 4: Add queued behind a card's save and reported success at once.
    await useSession(page, sessionFor(info, 'add-queued'));
    const id = 'browse_06';
    await seedDeviceHearts(page, [{ id }]);
    const save = await holdPut(page, id, { fail: true });
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    const heart = cardHeart(page, 'Browse test story 06');
    await expect(heart).toHaveAttribute('data-heart-state', 'off');
    await heart.click(); // the card's own save: held, then it fails
    await save.seen;
    const prompt = page.locator('[data-device-hearts-prompt]');
    await prompt.getByRole('button', { name: 'Add' }).click(); // queued behind it
    save.release();
    await expect(prompt.getByRole('alert')).toHaveText(
      'Something went wrong. Please try again later.',
    );
    await expect(prompt).toContainText(
      'Add the story you hearted on this device to your account?',
    );
    // Trying again saves it (the stub answers from now on).
    const saved = page.waitForResponse((r) =>
      isCommand('PUT', id)(r.request()),
    );
    await prompt.getByRole('button', { name: 'Try again' }).click();
    expect((await saved).status()).toBe(204);
    await expect(prompt).toHaveCount(0);
  });

  test('when Add saves one story and not another, it says so and offers just that one again', async ({
    page,
  }, info) => {
    // Codex, #117 round 5: marking the saved one cleared the failure and its Try again.
    await useSession(page, sessionFor(info, 'add-partly'));
    await seedDeviceHearts(page, [{ id: 'browse_07' }, { id: 'browse_08' }]);
    const failing = await holdPut(page, 'browse_08', { fail: true });
    const savedOne = page.waitForResponse((r) =>
      isCommand('PUT', 'browse_07')(r.request()),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    const prompt = page.locator('[data-device-hearts-prompt]');
    await expect(prompt).toContainText(
      'Add the 2 stories you hearted on this device to your account?',
    );
    await prompt.getByRole('button', { name: 'Add' }).click();
    expect((await savedOne).status()).toBe(204);
    await failing.seen;
    failing.release(); // browse_08's save fails (503)
    await expect(prompt.getByRole('alert')).toHaveText(
      'Something went wrong. Please try again later.',
    );
    await expect(prompt).toContainText(
      'Add the story you hearted on this device to your account?',
    );
    await expect(
      prompt.getByRole('button', { name: 'Try again' }),
    ).toBeVisible();

    const retried = page.waitForResponse((r) =>
      isCommand('PUT', 'browse_08')(r.request()),
    );
    await prompt.getByRole('button', { name: 'Try again' }).click();
    expect((await retried).status()).toBe(204);
    await expect(prompt).toHaveCount(0);
  });

  test('a heart taken off while the prompt’s Add is still saving it ends off, on the server too', async ({
    page,
  }, info) => {
    // Codex, #117 round 3: Add skipped the per-story queue, so its save could land last.
    await useSession(page, sessionFor(info, 'add-undo'));
    const id = 'browse_06';
    const title = 'Browse test story 06';
    await seedDeviceHearts(page, [{ id }]);
    const save = await holdPut(page, id);
    const deletes = countRequests(page, isCommand('DELETE', id));
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    const heart = cardHeart(page, title);
    await expect(heart).toHaveAttribute('data-heart-state', 'off');
    const prompt = page.locator('[data-device-hearts-prompt]');
    await prompt.getByRole('button', { name: 'Add' }).click();
    await save.seen;
    await expect(heart).toHaveAttribute('aria-pressed', 'true');
    await heart.click(); // off again, while Add's save is on its way
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    expect(deletes()).toBe(0); // it waits for the save
    const removed = page.waitForResponse((r) =>
      isCommand('DELETE', id)(r.request()),
    );
    save.release();
    expect((await removed).status()).toBe(204);
    await page.reload();
    await expect(cardHeart(page, title)).toHaveAttribute(
      'data-heart-state',
      'off',
    );
  });

  test('when saving fails, the heart goes back and says so', async ({
    page,
  }, info) => {
    const project = info.project.name;
    await useSession(page, sessionFor(info, 'fails'));
    const id = `heart_test_${project.replace('-', '_')}`;
    await page.route(`${STUB_USER_URL}${FAVOURITES}/${id}`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            headers: {
              'access-control-allow-origin': new URL(WEB_SIGNED_IN_URL).origin,
            },
            body: JSON.stringify({
              type: 'about:blank',
              title: 'Service unavailable',
              status: 503,
            }),
          })
        : route.fallback(),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}${HEART_PAGE}`);
    const heart = cardHeart(page, `Heart test story (${project})`);
    await expect(heart).toHaveAttribute('data-heart-state', 'off');
    await heart.click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Something went wrong. Please try again later.' }),
    ).toHaveCount(1);
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
  });
});

// Joel, 2026-10-31: favourites show stories as browse does (the same masonry and cards):
// each card at its media's own clamped shape (D53), a written story without a picture as text
// only, and the cards stacked in staggered columns, not in even rows. Every device, as the
// column count changes with the width. Stub: `aspect-test`'s stories (stub-api.mjs).
test('Favourites only keeps each card at its media’s shape, in browse’s masonry', async ({
  page,
  request,
}, info) => {
  const session = sessionFor(info, 'shapes');
  await useSession(page, session);
  const shapes = [
    ['aspect_test_portrait', 'Aspect test: a 3:4 picture', 3 / 4],
    ['aspect_test_vertical', 'Aspect test: a 9:16 video', 9 / 16],
    ['aspect_test_landscape', 'Aspect test: a 16:9 video', 16 / 9],
    ['aspect_test', 'Aspect test: the story', null],
  ] as const;
  await heartAtStub(
    request,
    session,
    shapes.map(([id]) => id),
  );
  await page.goto(FAVOURITES_ONLY);
  const list = page.locator('[data-favourites] ul.masonry');
  await expect(list.locator('> li')).toHaveCount(shapes.length);
  await expectNoHorizontalOverflow(page);

  for (const [, title, aspect] of shapes) {
    const card = list.locator('article').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
    const media = card.locator('[data-card-media]');
    if (aspect === null) {
      // Text only: no picture or placeholder box.
      await expect(media, title).toHaveCount(0);
      continue;
    }
    await expect(media.locator('img'), title).toBeVisible();
    const box = await media.boundingBox();
    expect(box && box.width / box.height, title).toBeCloseTo(aspect, 1);
  }

  // Staggered once the browser has measured the cards (the observer can report late).
  const width = page.viewportSize()?.width ?? 0;
  await expect(async () =>
    expectStaggered(await masonryBoxes(list), width),
  ).toPass();
});

/** `n` of the stub's browse stories, newest first: `browse_01`… */
const browseIds = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `browse_${String(i + 1).padStart(2, '0')}`,
  );

/** The stub's browse stories `browse_01`…`browse_08` (browse_01 published last). */
const EIGHT = browseIds(8);
/** Each card's title, from its number (03 and 08 have a long title that wraps). */
const titleOf = (n: number) => new RegExp(`^Browse test story 0${n}\\b`);
const titlesOf = (...ns: number[]) => ns.map(titleOf);

// FV-2 B (Joel, 2026-11-14): with "Favourites only" on, browse's search, sort, format and theme
// filters stay and work on the favourites, with browse's meanings, kept in the address. The
// eight stories' formats: 01 video, 02 written, 03 video, 04 audio, 05 written, 06 video,
// 07 written, 08 video; 04 alone has the themes Depression and Salvation (stub-api.mjs).
async function filtersOverFavourites(page: Page, base: string) {
  const only = page.getByRole('switch', { name: 'Favourites only' });
  const cards = page.locator('[data-favourites] article h2');
  await page.goto(`${base}/stories?favourites=1`);
  await expect(only).toBeChecked();
  // Latest first, by when each story was published (as browse), whatever the hearts' order.
  await expect(cards).toHaveText(titlesOf(1, 2, 3, 4, 5, 6, 7, 8));

  const search = page.getByRole('search', { name: 'Stories' });
  await search.getByLabel('Sort').selectOption('oldest');
  await expect(page).toHaveURL(`${base}/stories?sort=oldest&favourites=1`);
  await expect(cards).toHaveText(titlesOf(8, 7, 6, 5, 4, 3, 2, 1));

  await search.getByLabel('Format').selectOption('video');
  await expect(cards).toHaveText(titlesOf(8, 6, 3, 1));

  // Search: every word, in the title, description or theme names, case ignored.
  await search.getByLabel('Search stories').fill('WRAPS over');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(only).toBeChecked();
  await expect(cards).toHaveText(titlesOf(8, 3));
  await expect(page).toHaveURL(/favourites=1/);

  // A theme's name is searched too, and a theme filters.
  await page.goto(`${base}/stories?favourites=1&q=depression`);
  await expect(cards).toHaveText(titlesOf(4));
  await page.goto(`${base}/stories?favourites=1&theme=salvation`);
  await expect(cards).toHaveText(titlesOf(4));

  // Nothing matches: Clear filters keeps Favourites only.
  await page.goto(`${base}/stories?favourites=1&theme=salvation&format=video`);
  await expect(
    page.getByText('None of your favourites match these filters.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(`${base}/stories?favourites=1`);
  await expect(only).toBeChecked();
  await expect(cards).toHaveCount(8);
}

test.describe('filters over favourites', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'behaviour is checked on one phone and one desktop',
    );
  });

  test('signed in: search, sort, format and theme filter the account’s favourites', async ({
    page,
    request,
  }, info) => {
    const session = sessionFor(info, 'filters');
    await useSession(page, session);
    // Hearted oldest story first, so the newest heart is browse_08.
    await heartAtStub(request, session, [...EIGHT].reverse());
    await filtersOverFavourites(page, WEB_SIGNED_IN_URL);
  });

  test('signed out: search, sort, format and theme filter this browser’s hearts', async ({
    page,
  }) => {
    await seedDeviceHearts(
      page,
      EIGHT.map((id) => ({ id })),
    );
    await filtersOverFavourites(page, '');
  });
});

// The whole list is loaded, every page of it (FV-2 B: filtered in the browser). 52 hearts (the
// stub's 48 browse stories and 4 others) are 2 of api-user's pages.
test('Favourites only shows every favourite, across api-user’s pages', async ({
  page,
  request,
}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'behaviour is checked on one phone and one desktop',
  );
  const session = sessionFor(info, 'every-page');
  await useSession(page, session);
  await heartAtStub(request, session, [
    ...browseIds(48),
    'long_story',
    'video_story',
    'audio_story',
    'image_story',
  ]);
  await page.goto(FAVOURITES_ONLY);
  const cards = page.locator('[data-favourites] ul.masonry > li');
  await expect(cards).toHaveCount(52);
  await expect(
    page.locator('[data-favourites]').getByText('Browse test story 48'),
  ).toBeAttached();
  await expectNoHorizontalOverflow(page);
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('Favourites only and the hearts fit the screen, with 44 px targets', async ({
      page,
      request,
    }, info) => {
      const project = info.project.name;
      const session = sessionFor(info, `layout-${scheme}`);
      await useSession(page, session);
      // A video, an audio and a written story.
      await heartAtStub(request, session, [
        'browse_01',
        'browse_02',
        'browse_03',
      ]);
      await page.goto(FAVOURITES_ONLY);
      const hearts = page.locator('[data-favourites] [data-heart]');
      await expect(hearts).toHaveCount(3);
      await expect(hearts.first()).toHaveAttribute('aria-pressed', 'true');
      if (SCREENSHOT_DEVICES.includes(project))
        await page.screenshot({
          path: `test-output/e2e/screenshots/${project}/${scheme}-favourites-only.jpg`,
          fullPage: true,
          type: 'jpeg',
          scale: 'css',
          quality: 50,
        });
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      for (const heart of await hearts.all()) await expectTarget(page, heart);

      // A card's heart and the story page's, on the stories pages.
      await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
      const first = page.locator('main article [data-heart]').first();
      await expect(first).toHaveAttribute('data-heart-state', /on|off/);
      await expectTarget(page, first);
      await expectNoHorizontalOverflow(page);
      await page.goto(`${WEB_SIGNED_IN_URL}/stories/long-words`);
      const storyHeart = page.getByRole('button', {
        name: 'Favourite',
        exact: true,
      });
      await expectTarget(page, storyHeart);
      await expectNoHorizontalOverflow(page);
    });

    test('signed in: the prompt to add the device’s hearts fits the screen, with 44 px targets', async ({
      page,
    }, info) => {
      const project = info.project.name;
      await useSession(page, sessionFor(info, `prompt-${scheme}`));
      await seedDeviceHearts(page, [{ id: 'browse_01' }, { id: 'browse_02' }]);
      await page.goto(`${WEB_SIGNED_IN_URL}/about`);
      const prompt = page.locator('[data-device-hearts-prompt]');
      await expect(prompt).toBeVisible();
      if (SCREENSHOT_DEVICES.includes(project))
        await page.screenshot({
          path: `test-output/e2e/screenshots/${project}/${scheme}-device-hearts-prompt.jpg`,
          type: 'jpeg',
          scale: 'css',
          quality: 50,
        });
      await expectNoHorizontalOverflow(page);
      for (const name of ['Not now', 'Add'])
        await expectTarget(page, prompt.getByRole('button', { name }));
      const box = await prompt.locator('> div').boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    });
  });
}
