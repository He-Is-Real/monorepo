import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow, shots } from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// The person's own preview and the share flow's clickable steps (M3 plan PR 2, part 1b; Joel,
// 2026-11-10), on the signed-in server against the stub api-user (stub-api-user.mjs, checked
// against api-user.yaml in contract.e2e.ts). The stub signs a seeded story's own player link on
// GetStory once its file is processed (`processing: 'ready'`), as api-user does; the real signing
// rules (an hour, owner only, none while processing) are
// apps/api-user/integration/owner-preview.int-spec.ts. Each test is its own person (T4).

const SHARE = `${WEB_SIGNED_IN_URL}/share`;
const TEXT =
  'I was lost for years, and I did not think anyone could reach me. '.repeat(5);
const VIDEO_ID = '00000000-0000-4000-8000-0000000000aa';

async function person(
  page: Page,
  request: APIRequestContext,
  seed: Record<string, unknown> = {},
) {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: seed,
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  return {
    /** What the TUS server does with the next PATCHes. */
    tus: async (set: { hold?: boolean }) =>
      expect(
        (
          await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}/tus`, {
            data: set,
          })
        ).status(),
      ).toBe(204),
  };
}

/** A video draft ready to send, its file at Bunny; `ready`: Bunny has processed it. */
const videoDraft = (ready: boolean, over: Record<string, unknown> = {}) => ({
  testimony: 3,
  stories: [
    {
      id: 'v1',
      title: 'My video',
      primaryFormat: 'video',
      body: null,
      bylineName: 'Ann',
      description: 'How I found hope',
      themeIds: ['healing'],
      videoId: VIDEO_ID,
      uploaded: true,
      ...(ready ? { processing: 'ready' } : {}),
      ...over,
    },
  ],
});

const step = (page: Page, name: string) =>
  expect(
    page.getByRole('heading', { level: 2, name, exact: true }),
  ).toBeFocused();
/** The step showing when the page opens (its heading takes focus only once the person moves). */
const shown = (page: Page, name: string) =>
  expect(
    page.getByRole('heading', { level: 2, name, exact: true }),
  ).toBeVisible();
const steps = (page: Page) => page.getByRole('navigation', { name: 'Steps' });
const stepButton = (page: Page, name: RegExp) =>
  steps(page).getByRole('button', { name });
/** The page's alert saying this (Next.js keeps an empty route announcer alert too). */
const alert = (page: Page, text: string) =>
  page.getByRole('alert').filter({ hasText: text });
/** A resumed video draft's upload step, once it knows the draft has its file. */
const hasItsFile = (page: Page) =>
  expect(
    page.getByText(/^This story already has an? (video|audio file)\./),
  ).toBeVisible();
/** A PNG of that size, drawn in the page. */
async function drawn(page: Page, width: number, height: number) {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = '#4e9ba0';
      ctx.fillRect(0, 0, w, h);
      const blob = await c.convertToBlob({ type: 'image/png' });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    [width, height],
  );
  return Buffer.from(bytes);
}
const preview = (page: Page) =>
  page.getByRole('link', { name: /See your story as others will/ });

test.describe('the preview page fits every screen', () => {
  for (const ready of [true, false]) {
    test(`with the video ${ready ? 'ready' : 'still with Bunny'}, with 44 px targets`, async ({
      page,
      request,
    }, info) => {
      await person(page, request, videoDraft(ready));
      await page.goto(`${WEB_SIGNED_IN_URL}/account/stories/v1/preview`);
      await expect(page.locator('[data-preview-banner]')).toBeVisible();
      await expect(
        ready
          ? page.locator('iframe[title="Video: My video"]')
          : page.locator('[data-preview-later]'),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(
        page,
        info.project.name,
        'light',
        `own-preview-${ready ? 'ready' : 'later'}`,
        { signedIn: true },
      );
    });
  }
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'behaviour runs on one phone and one desktop',
    );
  });

  test('the review step plays my own video once Bunny has it, and links to the preview', async ({
    page,
    request,
  }) => {
    await person(page, request, videoDraft(true));
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your video');
    await hasItsFile(page);
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    const player = page.locator('[data-own-player] iframe');
    await expect(player).toHaveAttribute('title', 'Video: My video');
    await expect(player).toHaveAttribute(
      'src',
      new RegExp(
        `/embed/1/${VIDEO_ID}\\?token=stub&expires=\\d+&autoplay=false`,
      ),
    );
    await expect(page.locator('[data-preview-later]')).toHaveCount(0);
    await expect(preview(page)).toHaveAttribute(
      'href',
      '/account/stories/v1/preview',
    );
    await expect(preview(page)).toHaveAttribute('target', '_blank');
  });

  test('while Bunny still has the video: “check back later”, and the story can be sent or kept as a draft anyway', async ({
    page,
    request,
  }) => {
    await person(page, request, videoDraft(false));
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your video');
    await hasItsFile(page);
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    await expect(page.locator('[data-preview-later]')).toHaveText(
      'Check back later for your video preview.',
    );
    await expect(page.locator('iframe')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.locator('[data-saved-draft]')).toContainText(
      'Saved as a draft.',
    );
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
  });

  test('an audio story says the same for its recording', async ({
    page,
    request,
  }) => {
    await person(
      page,
      request,
      videoDraft(false, { primaryFormat: 'audio', title: 'My voice' }),
    );
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your audio file');
    await hasItsFile(page);
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    await expect(page.locator('[data-preview-later]')).toHaveText(
      'Check back later for your audio preview.',
    );
  });

  test('the preview page shows my story as others will, with no heart, share or related stories, to me only', async ({
    page,
    request,
  }) => {
    await person(page, request, videoDraft(true));
    await page.goto(`${WEB_SIGNED_IN_URL}/account`);
    await page
      .locator('[data-submission]')
      .filter({ hasText: 'My video' })
      .getByRole('link', { name: 'Preview' })
      .click();
    await expect(page).toHaveURL(/\/account\/stories\/v1\/preview$/);
    await expect(page.locator('[data-preview-banner]')).toContainText(
      'Only you can see this preview',
    );
    const article = page.locator('article');
    await expect(
      article.getByRole('heading', { level: 1, name: 'My video' }),
    ).toBeVisible();
    await expect(article).toContainText('Not sent yet by Ann');
    await expect(
      article.locator('iframe[title="Video: My video"]'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Favourite: / }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
    await expect(page.getByLabel('Keep exploring')).toHaveCount(0);
    await expect(page.getByText('Does this resonate?')).toHaveCount(0);

    // Someone else's story (not in this person's account): not available.
    await page.goto(`${WEB_SIGNED_IN_URL}/account/stories/not-mine/preview`);
    await expect(page.locator('[data-preview-gone]')).toContainText(
      'This story isn’t available.',
    );
  });

  test('the steps at the top go back at once, and forward only as far as the steps are complete', async ({
    page,
    request,
  }) => {
    await person(page, request, { testimony: 3 });
    await page.goto(SHARE);
    // Nothing started: the later steps don't open yet.
    await shown(page, 'How would you like to share?');
    await stepButton(page, /^4\. Details/).click();
    await shown(page, 'How would you like to share?');
    await expect(stepButton(page, /^1\. Choose/)).toHaveAttribute(
      'aria-current',
      'step',
    );

    await page.getByRole('button', { name: 'Write my story' }).click();
    await step(page, 'Prepare your story');
    // Forward past an empty Write step: it stops there, with Write's own message.
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Write your story');
    await expect(page.getByText('Give your story a title.')).toBeVisible();
    await expect(page.getByText('Write your story here.')).toBeVisible();

    await page.getByLabel('Title').fill('Found');
    await page.getByLabel('Your story').fill(TEXT);
    // Keyboard: the step is a button like any other.
    await stepButton(page, /^5\. Review/).focus();
    await page.keyboard.press('Enter');
    // Details has no theme yet: it stops there and says the rule.
    await step(page, 'Add some details');
    await expect(alert(page, 'Choose 1–5 themes.')).toBeVisible();
    await expect(stepButton(page, /^4\. Details/)).toHaveAttribute(
      'aria-current',
      'step',
    );

    // Back to any earlier step, nothing lost.
    await stepButton(page, /^3\. Write/).click();
    await step(page, 'Write your story');
    await expect(page.getByLabel('Your story')).toHaveValue(TEXT);
    await stepButton(page, /^4\. Details/).click();
    await step(page, 'Add some details');
    await page.getByText('Healing', { exact: true }).click();
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    await expect(page.locator('#review-title')).toHaveText('Found');
    await stepButton(page, /^2\. Prepare/).click();
    await step(page, 'Prepare your story');
  });

  test('Back during an upload just goes back and stops it (V-2); forward waits for the file again', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request, { testimony: 3 });
    await page.goto(SHARE);
    await page
      .locator('label')
      .filter({ hasText: 'Upload a video file' })
      .click();
    await page.getByRole('button', { name: 'Share my video' }).click();
    await step(page, 'Prepare your story');
    await page.getByRole('button', { name: 'Upload my video' }).click();
    await step(page, 'Upload your video');
    await page.getByLabel('Title').fill('My video');
    await me.tus({ hold: true });
    const path = info.outputPath('clip.mp4');
    writeFileSync(path, Buffer.alloc(256 * 1024, 7));
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByRole('progressbar')).toBeVisible();

    // No question: the step changes and the upload's progress goes with it.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await step(page, 'Prepare your story');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    // No message either (the page's empty announcer region aside).
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(
      0,
    );

    // Forward stops at the upload step until the file is chosen again.
    await stepButton(page, /^4\. Details/).click();
    await step(page, 'Upload your video');
    await expect(
      alert(page, 'Your video hasn’t finished uploading.'),
    ).toBeVisible();
    await expect(stepButton(page, /^3\. Upload/)).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  // A picture on the story whose file never arrived holds the Write or Upload step back even
  // when the person left that step and goes forward from an earlier one (Codex #212 rebase, 1).
  for (const format of ['written', 'audio'] as const) {
    const write =
      format === 'written' ? 'Write your story' : 'Upload your audio file';
    const label = format === 'written' ? /^3\. Write/ : /^3\. Upload/;
    test(`going back and then forward past ${format === 'written' ? 'Write' : 'Upload'} stops there while the story’s picture hasn’t finished uploading`, async ({
      page,
      request,
    }) => {
      await person(page, request, {
        testimony: 3,
        stories: [
          {
            id: 'p1',
            title: 'Found',
            primaryFormat: format,
            body: format === 'written' ? TEXT : null,
            themeIds: ['healing'],
            ...(format === 'audio'
              ? { videoId: VIDEO_ID, uploaded: true }
              : {}),
            // Granted, but its file never reached the storage.
            image: {
              url: null,
              width: 900,
              height: 1200,
              alt: null,
              path: 'stories/p1/picture.webp',
            },
          },
        ],
      });
      await page.goto(`${SHARE}?draft=p1`);
      await shown(page, write);
      await expect(page.getByText('didn’t finish uploading')).toBeVisible();
      await stepButton(page, /^4\. Details/).click();
      await expect(alert(page, 'hasn’t been added yet')).toBeVisible();

      await stepButton(page, /^2\. Prepare/).click();
      await step(page, 'Prepare your story');
      // Forward from Prepare: the story still has that picture, so it stops at its step.
      await stepButton(page, /^5\. Review/).click();
      await step(page, write);
      await expect(page.getByText('didn’t finish uploading')).toBeVisible();
      await expect(stepButton(page, label)).toHaveAttribute(
        'aria-current',
        'step',
      );
    });
  }

  test('a picture chosen but never added goes with the step it was chosen on, so going forward again passes it', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      testimony: 3,
      stories: [
        {
          id: 'p2',
          title: 'Found',
          primaryFormat: 'written',
          body: TEXT,
          themeIds: ['healing'],
        },
      ],
    });
    await page.goto(`${SHARE}?draft=p2`);
    await shown(page, 'Write your story');
    // Without a title the picture can't be added: it stays on this device only.
    await page.getByLabel('Title').fill('');
    await page.getByLabel('Choose a picture').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 900, 1200),
    });
    await expect(
      alert(page, 'Write your title and your story first'),
    ).toBeVisible();
    await page.getByLabel('Title').fill('Found');
    await stepButton(page, /^2\. Prepare/).click();
    await step(page, 'Prepare your story');
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
  });

  test('a later step chosen while the story saves stays put if another file is chosen meanwhile (Codex #212, 1)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request, videoDraft(false));
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your video');
    await hasItsFile(page);
    // The story's next save waits until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const saving = new Promise<void>((r) => (arrived = r));
    await page.route(`${STUB_USER_URL}/v1/stories/v1`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      arrived();
      await held;
      return route.fallback();
    });
    await page.getByLabel('Title').fill('My video, again');
    await stepButton(page, /^4\. Details/).click();
    await saving;

    // While it saves, the person chooses another video: it starts, so Upload isn't complete.
    await me.tus({ hold: true });
    const path = info.outputPath('clip.mp4');
    writeFileSync(path, Buffer.alloc(256 * 1024, 7));
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText('Getting “clip.mp4” ready…')).toBeVisible();
    release();

    // The step chosen earlier doesn't take them away from it: Upload says to wait.
    await expect(
      alert(page, 'Your video hasn’t finished uploading.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeVisible();
    await expect(page.getByRole('progressbar')).toBeVisible();
  });

  test('a later step chosen before a new story’s first save goes on once that save makes the draft (Codex #212, round 2)', async ({
    page,
    request,
  }) => {
    await person(page, request, { testimony: 3 });
    await page.goto(SHARE);
    await page.getByRole('button', { name: 'Write my story' }).click();
    await step(page, 'Prepare your story');
    await stepButton(page, /^3\. Write/).click();
    await step(page, 'Write your story');
    // The save that creates the draft waits until the step is chosen.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const creating = new Promise<void>((r) => (arrived = r));
    await page.route(`${STUB_USER_URL}/v1/stories`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      arrived();
      await held;
      return route.fallback();
    });
    await page.getByLabel('Title').fill('Found');
    await page.getByLabel('Your story').fill(TEXT);
    await creating;
    // A change while it's created needs a second save, after the draft has its id.
    await page.getByLabel('Title').fill('Found again');
    await stepButton(page, /^5\. Review/).click();
    release();

    // The draft now has its id: the click still counts, and stops at Details for its theme.
    await step(page, 'Add some details');
    await expect(alert(page, 'Choose 1–5 themes.')).toBeVisible();
  });

  test('“Save as draft” after a submission whose answer was lost says it was sent, if it was (Codex #212, 2)', async ({
    page,
    request,
  }) => {
    await person(page, request, videoDraft(false));
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your video');
    await hasItsFile(page);
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    // The submission reaches api-user and goes through; its answer never arrives (that once).
    await page.route(
      `${STUB_USER_URL}/v1/stories/v1/submit`,
      async (route) => {
        await route.fetch();
        return route.abort('connectionreset');
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await step(page, 'Thank you for sharing your story');
    await expect(page.getByText('Saved as a draft.')).toHaveCount(0);
  });

  test('“Save as draft” while a submission is still being worked on sends that submission again, and says it was sent (Codex #212, round 2)', async ({
    page,
    request,
  }) => {
    await person(page, request, videoDraft(false));
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your video');
    await hasItsFile(page);
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    // The browser gives up on the submission while api-user is still working on it: it hasn't
    // committed yet, so the story still reads as a draft.
    const submits: { key: string | undefined }[] = [];
    let first!: { headers: Record<string, string>; body: string | null };
    await page.route(`${STUB_USER_URL}/v1/stories/v1/submit`, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      submits.push({ key: req.headers()['idempotency-key'] });
      if (submits.length === 1) {
        first = { headers: req.headers(), body: req.postData() };
        return route.abort('timedout');
      }
      // Pressing Save as draft sends it again; meanwhile the first one commits, then this one
      // replays its answer.
      expect(
        (
          await request.post(req.url(), {
            headers: first.headers,
            data: first.body ?? undefined,
          })
        ).status(),
      ).toBe(200);
      return route.fallback();
    });
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await step(page, 'Thank you for sharing your story');
    await expect(page.getByText('Saved as a draft.')).toHaveCount(0);
    expect(submits).toHaveLength(2);
    expect(submits[1].key).toBe(submits[0].key);
  });

  test('“Save as draft” keeps an unanswered submission until the story’s status can be read (Codex #212, round 3)', async ({
    page,
    request,
  }) => {
    await person(page, request, videoDraft(false));
    await page.goto(`${SHARE}?draft=v1`);
    await shown(page, 'Upload your video');
    await hasItsFile(page);
    await stepButton(page, /^5\. Review/).click();
    await step(page, 'Review and submit');
    // The story is submitted another way (another key, as from another tab); this tab's own
    // submission never reaches api-user, so sending it again is refused as stale (412).
    const keys: (string | undefined)[] = [];
    await page.route(`${STUB_USER_URL}/v1/stories/v1/submit`, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      keys.push(req.headers()['idempotency-key']);
      if (keys.length > 1) return route.fallback();
      expect(
        (
          await route.fetch({
            headers: { ...req.headers(), 'idempotency-key': randomUUID() },
          })
        ).status(),
      ).toBe(200);
      return route.abort('connectionreset');
    });
    // The first read of the story after that refusal fails.
    let reads = 0;
    await page.route(
      `${STUB_USER_URL}/v1/account/stories/v1`,
      async (route) => {
        if (route.request().method() !== 'GET' || keys.length < 2)
          return route.fallback();
        if (++reads === 1) return route.abort('connectionreset');
        return route.fallback();
      },
    );
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();

    // Refused as stale, but its status can't be read: nothing is confirmed.
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect.poll(() => reads).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Save as draft' }),
    ).toBeEnabled();
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();
    await expect(page.getByText('Saved as a draft.')).toHaveCount(0);

    // The submission is still kept: the next try reads the story, which was sent.
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await step(page, 'Thank you for sharing your story');
    await expect(page.getByText('Saved as a draft.')).toHaveCount(0);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});
