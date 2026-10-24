import { expect, type Locator, type Page, test } from '@playwright/test';

// The reading column (Joel, R1 option A, 2026-10-24): pages narrow their whole content column,
// never the text inside it, so the heading, the divider and share row, the text and the
// boxes in the column share its left and right edges (within 1 px). Every device, light only
// (the colour scheme doesn't change sizes).

async function edges(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('not rendered');
  return {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
  };
}

async function expectAligned(
  page: Page,
  column: Locator,
  parts: Record<string, Locator>,
) {
  const col = await edges(column);
  for (const [name, part] of Object.entries(parts)) {
    const e = await edges(part);
    expect(
      Math.abs(e.left - col.left),
      `${name}: left edge`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(e.right - col.right),
      `${name}: right edge`,
    ).toBeLessThanOrEqual(1);
  }
}

// Story pages are one centred column at every width (Joel, 2026-10-25: Related beside the text
// "feels too intrusive, almost like an ad placement"; design principles): the hero (title
// block, media, share row), then the reading text, then, after the story ends, Related stories
// and "Does this resonate?", as on phones. Nothing sits beside the text. Every kind of story:
// written with and without a picture (portrait, panorama), video (landscape, tall), audio, and
// long titles.
const STORIES: Record<string, { media: boolean }> = {
  'browse-test-02': { media: false }, // written, no picture
  'long-words': { media: false }, // written, a long title of unbreakable words
  'browse-test-12': { media: true }, // written, portrait picture
  'browse-test-09': { media: true }, // written, panorama picture
  'browse-test-03': { media: true }, // video, landscape, long title
  'video-story': { media: true }, // video, tall
  'browse-test-04': { media: true }, // audio
};

for (const [slug, { media: hasMedia }] of Object.entries(STORIES)) {
  test(`story ${slug}: one centred column, Related and "Does this resonate?" below the story`, async ({
    page,
  }) => {
    await page.goto(`/stories/${slug}`);
    const hero = page.locator('[data-story-hero]');
    const text = page.locator('[data-story-text]');
    const centre =
      (await page.evaluate(() => document.documentElement.clientWidth)) / 2;
    const expectCentred = async (name: string, locator: Locator) => {
      const e = await edges(locator);
      expect(
        Math.abs((e.left + e.right) / 2 - centre),
        `${name}: centred on the page`,
      ).toBeLessThanOrEqual(1);
      return e;
    };
    const h = await expectCentred('hero', hero);
    if (hasMedia) {
      const m = await expectCentred(
        'media',
        page.locator('[data-story-media]'),
      );
      expect(m.left, 'media: inside the hero').toBeGreaterThanOrEqual(
        h.left - 1,
      );
      expect(m.right, 'media: inside the hero').toBeLessThanOrEqual(
        h.right + 1,
      );
    }
    // Nothing beside the text: Related starts after the story ends.
    const relatedRegion = page.getByRole('region', { name: 'Related stories' });
    expect(
      (await edges(relatedRegion)).top,
      'Related: below the end of the text',
    ).toBeGreaterThan((await edges(text)).bottom);
    // The title block, the share row and the text share the reading column, centred.
    await expectCentred('text', text);
    await expectAligned(page, text, {
      'header (title block)': page.locator('article header h1').locator('..'),
      'share row and divider': page
        .getByRole('button', { name: 'Share' })
        .locator('..'),
      'first paragraph': text.locator('p').first(),
    });
    // Then Related stories and "Does this resonate?", in that order, centred.
    const related = await expectCentred('Related stories', relatedRegion);
    const resonate = await expectCentred(
      '"Does this resonate?"',
      page.getByRole('region', { name: 'Does this resonate?' }),
    );
    expect(
      resonate.top,
      '"Does this resonate?": below Related',
    ).toBeGreaterThan(related.bottom);
  });
}

test('privacy: heading, notice, text and table share the column', async ({
  page,
}, info) => {
  await page.goto('/privacy');
  const column = page.locator('main [data-reading-column]');
  await expectAligned(page, column, {
    'draft notice': page.getByRole('note'),
    heading: page.getByRole('heading', { level: 1 }),
    'first paragraph': page.locator('main p').nth(1),
    'cookies heading': page.getByRole('heading', {
      name: 'Cookies and storage',
    }),
  });
  // The table breaks out from 1024 px, by the same amount on both sides.
  const col = await edges(column);
  const table = await edges(page.locator('main table').locator('..'));
  const width = info.project.use.viewport?.width ?? 0;
  if (width >= 1024) {
    expect(
      Math.abs(col.left - table.left - (table.right - col.right)),
    ).toBeLessThanOrEqual(1);
  } else {
    expect(Math.abs(table.left - col.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(table.right - col.right)).toBeLessThanOrEqual(1);
  }
});

test('FAQs: the header and every question share the column', async ({
  page,
}) => {
  await page.goto('/faqs');
  const column = page.locator('main [data-reading-column]');
  const questions = page.locator('main [data-reading-column] li');
  await expectAligned(page, column, {
    header: page.locator('main header'),
    heading: page.getByRole('heading', { level: 1 }),
    'first question': questions.first(),
    'last question': questions.last(),
  });
});
