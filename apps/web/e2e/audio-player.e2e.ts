import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

// An audio story's shape is its thumbnail's (Joel, 2026-10-24): the person's own picture, or
// the site's default audio thumbnail (1280 x 720). The player box on the story page and in a
// card takes that shape, so the picture before playing has no bands, and the player fills it.
// Stub stories: `audio-story` has the person's own 1080 x 1350 picture, `play-test-audio` the
// default. The real sizes are checked on dev (apps/dev-seed/behavioural/media.behaviour.ts).

async function ratio(box: Locator) {
  const b = await box.boundingBox();
  return (b?.width ?? 0) / (b?.height ?? 1);
}

async function expectFills(page: Page, frame: Locator) {
  await expect(frame).toBeVisible();
  const [f, b] = [
    await frame.boundingBox(),
    await frame.locator('xpath=..').boundingBox(),
  ];
  for (const k of ['x', 'y', 'width', 'height'] as const)
    expect(
      Math.abs((f?.[k] ?? 0) - (b?.[k] ?? -9)),
      `player ${k}`,
    ).toBeLessThan(1);
  const width = page.viewportSize()?.width ?? 0;
  expect((b?.x ?? -1) >= 0 && (b?.x ?? 0) + (b?.width ?? 0) <= width).toBe(
    true,
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the story page’s audio player takes its thumbnail’s shape', async ({
      page,
    }) => {
      await page.goto('/stories/audio-story');
      const frame = page.locator('iframe[title="Audio: Test story: audio"]');
      await expectFills(page, frame);
      expect(await ratio(frame)).toBeCloseTo(1080 / 1350, 2);
      await expectNoHorizontalOverflow(page);
    });

    test('an audio card shows its thumbnail at its shape, and plays in the same box', async ({
      page,
    }) => {
      await page.goto('/stories?tag=play-test');
      const card = page.locator('article').filter({
        has: page.getByRole('heading', { name: 'Play test: audio' }),
      });
      const box = card.locator('[data-card-media]');
      await expect(box.locator('img')).toHaveAttribute(
        'src',
        /\/media\/1280x720\.svg/,
      );
      expect(await ratio(box)).toBeCloseTo(1280 / 720, 2);
      await page
        .getByRole('button', { name: 'Play Play test: audio', exact: true })
        .click();
      const frame = card.locator('iframe[title="Audio: Play test: audio"]');
      await expectFills(page, frame);
      // The same shape, unless that's shorter than the player's controls need (184 px).
      const f = await frame.boundingBox();
      expect(f?.height ?? 0).toBeCloseTo(
        Math.max(((f?.width ?? 0) * 720) / 1280, 184),
        0,
      );
      await expectNoHorizontalOverflow(page);
    });
  });
}
