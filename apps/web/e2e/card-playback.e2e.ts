import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow, expectTarget } from './helpers';
import { STUB_PORT } from './playwright.config';

// Playing a story from its card (Joel, 2026-10-24): a video or audio card's media area plays the
// story in place, in Bunny's player (the stub's here), with a player link signed on demand by
// api-public-read (a server action reads the story, D32). The text below still opens the story's
// page. Written cards are unchanged. One card plays at a time. Stub stories: `tag=play-test`.

const LIST = '/stories?tag=play-test';
const VIDEO = 'Play test: a wide video';
const AUDIO = 'Play test: audio';
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
// Clicks land where a person's would: on the excerpt, under the title link's stretched area
// (`force` skips Playwright's "another element would receive the click" check).

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
  // Same page, same box: the masonry doesn't move.
  await expect(page).toHaveURL(LIST);
  expect(await size(media(video))).toEqual(before);
  await expectNoHorizontalOverflow(page);
  await expectTarget(page, video.getByRole('button', { name: 'Close player' }));

  // The text part still opens the story's page.
  await video
    .getByText('Placeholder story for the card playback tests.')
    .click({ force: true });
  await expect(page).toHaveURL(/\/stories\/play-test-video$/);
  await expect(
    page.getByRole('heading', { level: 1, name: VIDEO }),
  ).toBeVisible();
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
});

test('written cards open the story from anywhere on the card', async ({
  page,
}) => {
  await page.goto(LIST);
  const written = card(page, 'Play test: written');
  await expect(written.getByRole('button')).toHaveCount(0);
  await written
    .getByText('Placeholder story for the card playback tests.')
    .click({ force: true });
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
