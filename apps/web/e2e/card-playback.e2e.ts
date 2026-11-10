import { randomUUID } from 'node:crypto';
import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectNoHorizontalOverflow, expectTarget } from './helpers';
import { STUB_PORT } from './servers';

// Video and audio cards show Bunny's player directly (the stub's here), in the card's media box,
// with no picture or play button of our own over it; its link comes with the card (Joel,
// 2026-11-09, "Cards A"). Nothing plays on its own; one card plays at a time on the page: starting
// one pauses the others through the player's control API (Player.js, which the stub speaks). The
// text below still opens the story's page. Written cards are unchanged. Stub stories:
// `theme=play_test`.

const LIST = '/stories?theme=play_test';
const VIDEO = 'Play test: a wide video';
const AUDIO = 'Play test: audio';
/** components/stories/story-media.tsx: the shortest box Bunny's controls fit in. */
const PLAYER_MIN_HEIGHT = 184;
const embed = (id: string) => `http://127.0.0.1:${STUB_PORT}/embed/1/${id}?`;
const VIDEO_ID = '11111111-1111-4111-8111-111111111111';

const card = (page: Page, title: string) =>
  page.locator('article').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
const media = (c: Locator) => c.locator('[data-card-media]');
const frameOf = (c: Locator, title: string) =>
  c.locator(`iframe[title$=": ${title}"]`);
/** Inside a card's player: its Play button and what it says it is doing. */
const playerOf = (c: Locator, title: string): FrameLocator =>
  c.frameLocator(`iframe[title$=": ${title}"]`);
const state = (player: FrameLocator) => player.locator('[data-state]');

/**
 * Clicks a card where a person's click would land: on `part` (the excerpt, under the title
 * link's stretched area). The click is on the card, at that part's place in it, so Playwright
 * still checks the card holds still and is what the pointer hits, and tries again if not: once
 * the page's script runs, the masonry swaps the server's predicted heights for measured ones and
 * cards move up (story-masonry.tsx), on a slow machine just as a click lands.
 */
async function clickCardAt(c: Locator, part: Locator) {
  // Both boxes in one go, so the offset is the part's place in the card wherever the card is.
  const position = await part.evaluate((el) => {
    const card = el.closest('article')?.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      x: box.x - (card?.x ?? 0) + box.width / 2,
      y: box.y - (card?.y ?? 0) + box.height / 2,
    };
  });
  await c.click({ position });
}

async function size(locator: Locator) {
  const box = await locator.boundingBox();
  return {
    width: Math.round(box?.width ?? 0),
    height: Math.round(box?.height ?? 0),
  };
}

// Every device: the player box's size depends on the card's width.
test('a card shows its player in its own box, at its shape, never shorter than the controls need', async ({
  page,
}) => {
  await page.goto(LIST);
  for (const [title, aspect] of [
    [VIDEO, 1920 / 1080],
    [AUDIO, 1280 / 720], // the default audio thumbnail's shape
  ] as const) {
    const c = card(page, title);
    const frame = frameOf(c, title);
    await frame.scrollIntoViewIfNeeded();
    await expect(frame).toBeVisible();
    // No picture or play button of our own: the player is the box.
    await expect(media(c).locator('img')).toHaveCount(0);
    await expect(c.getByRole('button', { name: /^Play / })).toHaveCount(0);
    const box = await size(media(c));
    expect(await size(frame)).toEqual(box);
    expect(
      Math.abs(box.height - Math.max(box.width / aspect, PLAYER_MIN_HEIGHT)),
      title,
    ).toBeLessThanOrEqual(1);
    await expectTarget(page, playerOf(c, title).getByRole('button'));
  }
  await expectNoHorizontalOverflow(page);
});

test('the story page’s players are tall enough for Bunny’s controls', async ({
  page,
}) => {
  for (const [slug, title] of [
    ['audio-story', 'Audio: Test story: audio'],
    [
      'browse-test-03',
      'Video: Browse test story 03: a much longer title that wraps over more than one line',
    ], // 16:9
  ]) {
    await page.goto(`/stories/${slug}`);
    const frame = page.locator(`iframe[title="${title}"]`);
    await expect(frame).toBeVisible();
    expect((await size(frame)).height).toBeGreaterThanOrEqual(
      PLAYER_MIN_HEIGHT,
    );
  }
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('the player comes with the card, nothing plays on its own, and the text below opens the story', async ({
    page,
  }) => {
    await page.goto(LIST);
    const video = card(page, VIDEO);
    const frame = frameOf(video, VIDEO);
    await frame.scrollIntoViewIfNeeded();
    // The card's own signed link (api-public-read, D52), with autoplay and preload off.
    const src = new URL((await frame.getAttribute('src')) ?? '');
    expect(src.href.startsWith(embed(VIDEO_ID))).toBe(true);
    expect(src.searchParams.get('token')).toBe('stub');
    expect(src.searchParams.get('autoplay')).toBe('false');
    expect(src.searchParams.get('preload')).toBe('false');
    for (const title of [VIDEO, AUDIO]) {
      const c = card(page, title);
      await frameOf(c, title).scrollIntoViewIfNeeded();
      await expect(state(playerOf(c, title))).toHaveText('Paused');
    }

    // Playing happens in the card; the page stays.
    await playerOf(video, VIDEO).getByRole('button', { name: 'Play' }).click();
    await expect(state(playerOf(video, VIDEO))).toHaveText('Playing');
    await expect(page).toHaveURL(LIST);

    // The text part still opens the story's page.
    await clickCardAt(
      video,
      video.getByText('Placeholder story for the card playback tests.'),
    );
    await expect(page).toHaveURL(/\/stories\/play-test-video$/);
    await expect(
      page.getByRole('heading', { level: 1, name: VIDEO }),
    ).toBeVisible();
  });

  test('starting another card pauses the one playing', async ({ page }) => {
    await page.goto(LIST);
    const video = playerOf(card(page, VIDEO), VIDEO);
    const audio = playerOf(card(page, AUDIO), AUDIO);
    await frameOf(card(page, VIDEO), VIDEO).scrollIntoViewIfNeeded();
    await video.getByRole('button', { name: 'Play' }).click();
    await expect(state(video)).toHaveText('Playing');

    await frameOf(card(page, AUDIO), AUDIO).scrollIntoViewIfNeeded();
    await audio.getByRole('button', { name: 'Play' }).click();
    await expect(state(audio)).toHaveText('Playing');
    await expect(state(video)).toHaveText('Paused');

    // And back again.
    await frameOf(card(page, VIDEO), VIDEO).scrollIntoViewIfNeeded();
    await video.getByRole('button', { name: 'Play' }).click();
    await expect(state(video)).toHaveText('Playing');
    await expect(state(audio)).toHaveText('Paused');
  });

  test('the heart sits in the card’s top line, below the player, a whole target', async ({
    page,
  }) => {
    await page.goto(LIST);
    for (const title of [VIDEO, 'Play test: written']) {
      const c = card(page, title);
      const heart = c.locator('[data-heart]');
      await expectTarget(page, heart);
      const h = await heart.boundingBox();
      const label = await c.locator('[data-card-label]').boundingBox();
      // Centred on the top line, at its end.
      expect(
        Math.abs(
          (h?.y ?? 0) +
            (h?.height ?? 0) / 2 -
            ((label?.y ?? 0) + (label?.height ?? 0) / 2),
        ),
        title,
      ).toBeLessThanOrEqual(2);
      const box =
        (await media(c).count()) > 0 ? await media(c).boundingBox() : null;
      if (box)
        expect(h?.y ?? 0, title).toBeGreaterThanOrEqual(box.y + box.height);
    }
  });

  test('written cards open the story from anywhere on the card', async ({
    page,
  }) => {
    await page.goto(LIST);
    const written = card(page, 'Play test: written');
    // No player: its only button is the heart (favourites.e2e.ts).
    await expect(written.locator('button:not([data-heart])')).toHaveCount(0);
    await expect(written.locator('iframe')).toHaveCount(0);
    await clickCardAt(
      written,
      written.getByText('Placeholder story for the card playback tests.'),
    );
    await expect(page).toHaveURL(/\/stories\/play-test-written$/);
  });
});

test('home’s “Recently shared” cards show their players too', async ({
  page,
}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
  await page.goto('/');
  const c = card(page, 'Test story: audio');
  await frameOf(c, 'Test story: audio').scrollIntoViewIfNeeded();
  const player = playerOf(c, 'Test story: audio');
  await expectTarget(page, player.getByRole('button', { name: 'Play' }));
  await expect(state(player)).toHaveText('Paused');
  await expectNoHorizontalOverflow(page);
});

// Codex, #77: nothing prefetches a story's page (which reads the story). The stub counts each
// story's reads; each run makes its own story, so repeats and workers never share a count.
test('a story’s page is read only when someone opens it, never ahead of it', async ({
  page,
  request,
}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
  const slug = `prefetch-test-${randomUUID()}`;
  const title = `Prefetch test ${slug}`;
  expect(
    (
      await request.post(
        `http://127.0.0.1:${STUB_PORT}/__test/story?slug=${slug}`,
      )
    ).status(),
  ).toBe(204);
  const reads = async () =>
    (
      await (
        await request.get(
          `http://127.0.0.1:${STUB_PORT}/__test/reads?slug=${slug}`,
        )
      ).json()
    ).reads as number;
  // Every request the browser makes for the story's page (a prefetch is one).
  const asked: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === `/stories/${slug}`) asked.push(r.url());
  });
  await page.goto(`/stories?theme=prefetch_test&q=${slug}`);
  const c = card(page, title);
  // Its player is there and the page has hydrated: from then on Next would prefetch the link
  // in view, and on hover.
  await expect(frameOf(c, title)).toBeVisible();
  await expect(c.locator('[data-heart]')).toHaveAttribute(
    'data-heart-state',
    /on|off/,
  );
  const link = page.getByRole('link', { name: title });
  await link.scrollIntoViewIfNeeded();
  await link.hover();
  await page.waitForLoadState('networkidle');
  expect(asked, 'nothing asked for the story’s page').toEqual([]);
  expect(await reads()).toBe(0);
});

test("a story page's related cards show their players from 1024 px", async ({
  page,
}, info) => {
  // Below 1024 px, Related is a small list of links (story-view.tsx), as on phones.
  test.skip(info.project.name !== 'desktop-1280', 'one desktop');
  await page.goto('/stories/browse-test-03');
  const related = page.getByRole('region', { name: 'Related stories' });
  const frame = related.locator('iframe').first();
  await frame.scrollIntoViewIfNeeded();
  await expect(frame).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

// Joel, 2026-10-31: every related preview keeps its own (clamped, D53) shape, on phones' small
// list and in the desktop row, and a video's player fills its own shape's box (as browse's cards
// do). Stub: `aspect-test`'s related stories.
test('a story page’s related previews keep their own shapes', async ({
  page,
}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
  const shapes = [
    ['Aspect test: a 3:4 picture', 3 / 4],
    ['Aspect test: a 9:16 video', 9 / 16],
    ['Aspect test: a 16:9 video', 16 / 9],
  ] as const;
  const ratio = async (locator: Locator) => {
    const { width, height } = (await locator.boundingBox()) ?? {
      width: 0,
      height: 1,
    };
    return width / height;
  };
  await page.goto('/stories/aspect-test');
  const related = page.getByRole('region', { name: 'Related stories' });
  await expect(related).toBeVisible();
  await expectNoHorizontalOverflow(page);

  if (info.project.name === 'phone-320') {
    // The small list: each picture fits its slot at its own shape.
    for (const [title, aspect] of shapes) {
      const link = related.getByRole('link', { name: title });
      await expectTarget(page, link);
      const picture = link.locator('[data-related-picture]');
      await expect(picture.locator('img')).toBeVisible();
      expect(await ratio(picture), title).toBeCloseTo(aspect, 1);
    }
    return;
  }

  const cardOf = (title: string) =>
    related.locator('article').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
  // Mixed heights line up at the top.
  const tops = await Promise.all(
    shapes.map(async ([title]) => (await cardOf(title).boundingBox())?.y ?? -1),
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  for (const [title, aspect] of shapes) {
    const c = cardOf(title);
    if (!title.includes('video')) {
      await expect(media(c).locator('img')).toBeVisible();
      expect(await ratio(media(c)), title).toBeCloseTo(aspect, 1);
      continue;
    }
    // The player fills that box, never shorter than its controls need.
    await expect(frameOf(c, title)).toBeVisible();
    const box = await size(media(c));
    expect(await size(frameOf(c, title))).toEqual(box);
    expect(
      Math.abs(box.height - Math.max(box.width / aspect, PLAYER_MIN_HEIGHT)),
      title,
    ).toBeLessThanOrEqual(1);
  }
});

// Codex, #82: each Related layout is hidden at the other's widths, so a card playing in the
// desktop row would keep playing, out of sight, once the screen rotates below 1024 px. Hiding it
// pauses it.
test('rotating a tablet so Related’s cards hide pauses the one playing', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'ipad-air-landscape', 'one tablet');
  await page.goto('/stories/browse-test-03');
  const related = page.getByRole('region', { name: 'Related stories' });
  const c = related
    .locator('article')
    .filter({ has: page.locator('iframe') })
    .first();
  const frame = c.locator('iframe');
  await frame.scrollIntoViewIfNeeded();
  const player = c.frameLocator('iframe');
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(state(player)).toHaveText('Playing');

  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(frame).toBeHidden();
  await expect(state(player)).toHaveText('Paused');
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one device');
  });

  test('the cards still show their players, and the text opens the story', async ({
    page,
  }) => {
    await page.goto(LIST);
    const video = card(page, VIDEO);
    await expect(frameOf(video, VIDEO)).toBeVisible();
    await video.getByRole('link', { name: VIDEO }).click();
    await expect(page).toHaveURL(/\/stories\/play-test-video$/);
  });
});
