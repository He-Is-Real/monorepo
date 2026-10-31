import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectNoHorizontalOverflow, expectTarget } from './helpers';
import { STUB_PORT } from './servers';

// Playing a story from its card (Joel, 2026-10-24): a video or audio card's media area plays the
// story in place, in Bunny's player (the stub's here), with a player link signed on demand by
// api-public-read (a server action reads the story, D32). The text below still opens the story's
// page. Written cards are unchanged. One card plays at a time. Stub stories: `tag=play-test`.

const LIST = '/stories?tag=play-test';
const VIDEO = 'Play test: a wide video';
const AUDIO = 'Play test: audio';
/** components/stories/story-media.tsx: the shortest box Bunny's controls fit in. */
const PLAYER_MIN_HEIGHT = 184;
const embed = (id: string) => `http://127.0.0.1:${STUB_PORT}/embed/1/${id}?`;
const VIDEO_ID = '11111111-1111-4111-8111-111111111111';
const AUDIO_ID = '22222222-2222-4222-8222-222222222222';

const card = (page: Page, title: string) =>
  page.locator('article').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
const playButton = (page: Page, title: string) =>
  page.getByRole('button', { name: `Play ${title}`, exact: true });
const media = (c: Locator) => c.locator('[data-card-media]');

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

test('the media area plays the story in place; the text below opens the story', async ({
  page,
}) => {
  await page.goto(LIST);
  const video = card(page, VIDEO);
  const play = playButton(page, VIDEO);
  await expectTarget(page, play);
  const before = await size(media(video));

  await play.click();
  const frame = video.locator(`iframe[title="Video: ${VIDEO}"]`);
  await expect(frame).toBeVisible();
  // Signed on demand by api-public-read, and started by this click.
  const src = (await frame.getAttribute('src')) ?? '';
  expect(src.startsWith(embed(VIDEO_ID))).toBe(true);
  expect(new URL(src).searchParams.get('token')).toBe('stub');
  expect(new URL(src).searchParams.get('autoplay')).toBe('true');
  await expect(
    page.frameLocator(`iframe[title="Video: ${VIDEO}"]`).getByRole('button'),
  ).toBeVisible();
  // Same page and width; the same height unless that is shorter than the player's controls
  // need (184 px, PLAYER_MIN_HEIGHT): then the box grows to it once.
  await expect(page).toHaveURL(LIST);
  expect(await size(media(video))).toEqual({
    width: before.width,
    height: Math.max(before.height, PLAYER_MIN_HEIGHT),
  });
  expect(await size(frame)).toEqual(await size(media(video)));
  await expectNoHorizontalOverflow(page);
  await expectTarget(page, video.getByRole('button', { name: 'Close player' }));

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

test('a playing card’s Close is a real target: the heart steps aside while it plays', async ({
  page,
}, info) => {
  // Codex, #117 round 3: the card's heart sat on top of Close and took its clicks.
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
  await page.goto(LIST);
  const video = card(page, VIDEO);
  const heart = video.locator('[data-heart]');
  await expect(heart).toBeVisible();
  await playButton(page, VIDEO).click();
  const frame = video.locator(`iframe[title="Video: ${VIDEO}"]`);
  await expect(frame).toBeVisible();
  await expect(heart).toBeHidden();
  // A real click, where a person would tap: no `force`.
  await video.getByRole('button', { name: 'Close player' }).click();
  await expect(frame).toHaveCount(0);
  await expect(heart).toBeVisible();
});

test('starting another card stops the one playing', async ({ page }) => {
  await page.goto(LIST);
  await playButton(page, VIDEO).click();
  await expect(page.locator(`iframe[title="Video: ${VIDEO}"]`)).toBeVisible();

  await playButton(page, AUDIO).click();
  const audio = page.locator(`iframe[title="Audio: ${AUDIO}"]`);
  await expect(audio).toBeVisible();
  expect((await audio.getAttribute('src'))?.startsWith(embed(AUDIO_ID))).toBe(
    true,
  );
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(playButton(page, VIDEO)).toBeVisible();
  // An audio card's 2:1 box is 144 px tall on a 320 px phone: the player gets its 184 px.
  expect((await size(audio)).height).toBeGreaterThanOrEqual(PLAYER_MIN_HEIGHT);
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

test('written cards open the story from anywhere on the card', async ({
  page,
}) => {
  await page.goto(LIST);
  const written = card(page, 'Play test: written');
  // No player: its only button is the heart (favourites.e2e.ts).
  await expect(written.locator('button:not([data-heart])')).toHaveCount(0);
  await clickCardAt(
    written,
    written.getByText('Placeholder story for the card playback tests.'),
  );
  await expect(page).toHaveURL(/\/stories\/play-test-written$/);
});

test('a story that has gone, or an API that is down, shows a calm message and the link still works', async ({
  page,
}) => {
  await page.goto(LIST);
  const gone = card(page, 'Play test: a story that has gone');
  const before = await size(media(gone));
  await playButton(page, 'Play test: a story that has gone').click();
  await expect(
    gone.getByText('This story isn’t available any more.'),
  ).toBeVisible();
  await expect(gone.locator('iframe')).toHaveCount(0);
  expect(await size(media(gone))).toEqual(before);

  const down = card(page, 'Play test: the API is down');
  await playButton(page, 'Play test: the API is down').click();
  await expect(
    down.getByText('The player couldn’t load. Try again in a moment.'),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await down.getByRole('link', { name: 'Play test: the API is down' }).click();
  await expect(page).toHaveURL(/\/stories\/play-test-down$/);
});

test('a failed request (offline) shows the message, and playing again works', async ({
  page,
}) => {
  await page.goto(LIST);
  // Server actions are POSTs to the page: fail the first one.
  let failed = false;
  await page.route('**/stories*', (route) => {
    if (route.request().method() === 'POST' && !failed) {
      failed = true;
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  const video = card(page, VIDEO);
  await playButton(page, VIDEO).click();
  await expect(
    video.getByText('The player couldn’t load. Try again in a moment.'),
  ).toBeVisible();
  await playButton(page, VIDEO).click();
  await expect(video.locator(`iframe[title="Video: ${VIDEO}"]`)).toBeVisible();
});

test.describe('keyboard and home', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'desktop-1280'].includes(info.project.name),
      'checked on one phone and one desktop',
    );
  });

  test('Enter and Space play, focus moves into the player, Escape stops it', async ({
    page,
  }) => {
    await page.goto(LIST);
    const video = card(page, VIDEO);
    const play = playButton(page, VIDEO);
    await play.focus();
    // The card's link comes straight after its play button.
    await page.keyboard.press('Tab');
    await expect(video.getByRole('link', { name: VIDEO })).toBeFocused();
    await play.focus();
    await page.keyboard.press('Enter');
    const frame = video.locator(`iframe[title="Video: ${VIDEO}"]`);
    await expect(frame).toBeFocused();

    const close = video.getByRole('button', { name: 'Close player' });
    await close.focus();
    await page.keyboard.press('Escape');
    await expect(frame).toHaveCount(0);
    await expect(play).toBeFocused();

    await page.keyboard.press('Space');
    await expect(frame).toBeFocused();
    await close.press('Enter');
    await expect(frame).toHaveCount(0);
    await expect(play).toBeFocused();
  });

  test('home’s “Recently shared” cards play in place too', async ({ page }) => {
    await page.goto('/');
    const audio = page.getByRole('button', { name: 'Play Test story: audio' });
    await expectTarget(page, audio);
    await audio.click();
    await expect(
      page.locator('iframe[title="Audio: Test story: audio"]'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expectNoHorizontalOverflow(page);
  });
});

// Codex, #77: player links are signed only for stories someone plays or opens, so nothing
// prefetches a story's page (which reads the story, and so signs its links). The stub counts
// each story's reads; each run makes its own story, so repeats and workers never share a count.
test.describe('signing on demand', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'desktop-1280'].includes(info.project.name),
      'checked on one phone and one desktop',
    );
  });

  test('a story is read only when its card is played, never ahead of it', async ({
    page,
    request,
  }) => {
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
    await page.goto(`/stories?tag=prefetch-test&q=${slug}`);
    const link = page.getByRole('link', { name: title });
    await link.scrollIntoViewIfNeeded();
    await link.hover(); // Next prefetches links in view and on hover
    await page.waitForLoadState('networkidle');
    expect(await reads()).toBe(0);

    await playButton(page, title).click();
    await expect(page.locator(`iframe[title="Video: ${title}"]`)).toBeVisible();
    expect(await reads()).toBe(1);
  });
});

test("a story page's related cards play in place from 1024 px", async ({
  page,
}, info) => {
  // Below 1024 px, Related is a small list of links (story-view.tsx), as on phones.
  test.skip(info.project.name !== 'desktop-1280', 'one desktop');
  await page.goto('/stories/browse-test-03');
  const related = page.getByRole('region', { name: 'Related stories' });
  const play = related.getByRole('button', { name: /^Play / }).first();
  await expectTarget(page, play);
  const title = ((await play.getAttribute('aria-label')) ?? '').slice(5);
  await play.click();
  await expect(related.locator(`iframe[title$=": ${title}"]`)).toBeVisible();
  await expect(page).toHaveURL(/\/stories\/browse-test-03$/);
  await expectNoHorizontalOverflow(page);
});

// Joel, 2026-10-31: every related preview keeps its own (clamped, D53) shape, on phones' small
// list and in the desktop row, and a video plays in its own shape's box (as browse's cards
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
    await expect(media(c).locator('img')).toBeVisible();
    expect(await ratio(media(c)), title).toBeCloseTo(aspect, 1);
    if (title.includes('video')) {
      // Plays in place in that box, as in browse: the player shows the whole clip in it.
      await playButton(page, title).click();
      await expect(c.locator(`iframe[title="Video: ${title}"]`)).toBeVisible();
      const box = await size(media(c));
      expect(
        Math.abs(box.height - Math.max(box.width / aspect, PLAYER_MIN_HEIGHT)),
        `${title}: playing`,
      ).toBeLessThanOrEqual(1);
    }
  }
});

// Codex, #82: each Related layout is hidden at the other's widths, so a card playing in the
// desktop row would keep playing, out of sight and with no "Close player", once the screen
// rotates below 1024 px. Hiding it stops it.
test('rotating a tablet so Related’s cards hide stops the one playing', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'ipad-air-landscape', 'one tablet');
  await page.goto('/stories/browse-test-03');
  const related = page.getByRole('region', { name: 'Related stories' });
  const play = related.getByRole('button', { name: /^Play / }).first();
  const title = ((await play.getAttribute('aria-label')) ?? '').slice(5);
  await play.click();
  const frame = related.locator(`iframe[title$=": ${title}"]`);
  await expect(frame).toBeVisible();

  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(frame).toHaveCount(0);
  // Rotating back shows the card ready to play again, not playing.
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(play).toBeVisible();
  await expect(frame).toHaveCount(0);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one device');
  });

  test('the media area is a plain link to the story', async ({ page }) => {
    await page.goto(LIST);
    await media(card(page, VIDEO)).click();
    await expect(page).toHaveURL(/\/stories\/play-test-video$/);
  });
});
