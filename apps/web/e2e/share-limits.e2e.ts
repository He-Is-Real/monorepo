import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  enlargeText,
  expectAllTargets,
  expectNoHorizontalOverflow,
} from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// What people have left this week on /share (D94, D113), read from GET /v1/account/limits on the
// stub api-user (stub-api-user.mjs; the real counts are apps/api-user/integration). The page says
// it before they start, and at a limit it explains and holds the step back instead of letting
// them meet an error. Each test is its own person (T4).

const SHARE = `${WEB_SIGNED_IN_URL}/share`;
const DAY = 24 * 3600 * 1000;
const TEXT =
  'I was lost for years, and I did not think anyone could reach me. '.repeat(5);
/** "from Tuesday 4 November at 14:30" */
const FROM = /from \w+day \d+ \w+ at \d+:\d\d/;

interface Seed {
  settings?: Record<string, number>;
  stories?: Record<string, unknown>[];
  /** Video or audio uploads started this long ago. */
  uploadsAgo?: number[];
}

/** A signed-up person who has agreed to their story being stored and published. */
async function person(page: Page, request: APIRequestContext, seed: Seed) {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: {
      signupAccepted: true,
      granted: [
        'age_18plus',
        'account_data',
        'special_category_religious',
        'publish',
      ],
      ...seed,
    },
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  return {
    /** An admin changes the settings after the page loaded: its numbers are now stale. */
    settings: async (settings: Record<string, number>) =>
      expect(
        (
          await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}/settings`, {
            data: settings,
          })
        ).status(),
      ).toBe(204),
    uploadRequests: async () =>
      (
        (await (
          await request.get(`${STUB_USER_URL}/__e2e/sessions/${id}/uploads`)
        ).json()) as { requests: number }
      ).requests,
  };
}

const story = (id: string, extra: object = {}) => ({
  id,
  title: `Draft ${id}`,
  body: TEXT,
  primaryFormat: 'written',
  tagSlugs: ['hope'],
  ...extra,
});
const submitted = (id: string, daysAgo: number) =>
  story(id, {
    status: 'pending',
    submittedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  });

const thisWeek = (page: Page) =>
  page.getByRole('region', { name: 'What you can share this week' });
const pick = (page: Page, note: string) =>
  page.locator('label').filter({ hasText: note }).click();

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('before anything is started, the page says what’s left this week and each file’s limits', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      settings: { submissionsPer7Days: 3, uploadsPer7Days: 5 },
      stories: [submitted('sent', 1)],
      uploadsAgo: [2 * DAY, 3 * DAY],
    });
    await page.goto(SHARE);
    const box = thisWeek(page);
    await expect(box).toContainText(
      '2 of 3 stories left to send for review this week.',
    );
    await expect(box).not.toContainText('uploads');

    await pick(page, 'Upload a video file');
    await expect(box).toContainText(
      '3 of 5 video or audio uploads left this week.',
    );
    await expect(box).toContainText(
      'Videos: MP4, MOV or WebM, up to 4 GB and 15 minutes.',
    );
    await pick(page, 'Upload an audio file');
    await expect(box).toContainText(
      'Audio files: MP3, M4A or WAV, up to 500 MB and 15 minutes.',
    );
    await expect(
      page.getByRole('button', { name: 'Share my audio' }),
    ).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  });

  test('with no uploads left, a video story waits kindly: its start and its file chooser are held, a written story isn’t', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      stories: [story('vid', { title: 'My video', primaryFormat: 'video' })],
      uploadsAgo: [1, 2, 3, 4, 5].map((d) => d * DAY),
    });
    await page.goto(SHARE);
    await pick(page, 'Upload a video file');
    const held = thisWeek(page).locator('[data-allowance="uploads"]');
    await expect(held).toContainText(
      'You’ve used this week’s 5 uploads, which is all for now.',
    );
    await expect(held).toContainText(FROM);
    const start = page.getByRole('button', { name: 'Share my video' });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(/this week’s 5 uploads/);

    await pick(page, 'Write it here');
    await expect(
      page.getByRole('button', { name: 'Write my story' }),
    ).toBeEnabled();

    // A video draft from before: its upload step says the same, and no new file can start.
    await page.getByRole('button', { name: 'Continue “My video”' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeFocused();
    await expect(page.getByLabel('Choose a file')).toBeDisabled();
    await expect(page.locator('#upload-allowance')).toContainText(
      /this week’s 5 uploads.*You can upload your video from/,
    );
    await expectNoHorizontalOverflow(page);
  });

  test('each upload counts at once: the number left goes down, and the last one holds the next file', async ({
    page,
    request,
  }, info) => {
    await person(page, request, { settings: { uploadsPer7Days: 2 } });
    await page.goto(SHARE);
    await pick(page, 'Upload a video file');
    await expect(thisWeek(page)).toContainText('2 of 2 video or audio uploads');
    await page.getByRole('button', { name: 'Share my video' }).click();
    await page.getByRole('button', { name: 'Upload my video' }).click();
    await page.getByLabel('Title').fill('My video');
    const left = page.locator('#upload-allowance');
    await expect(left).toHaveText(
      '2 of 2 video or audio uploads left this week.',
    );

    const path = info.outputPath('clip.mp4');
    writeFileSync(path, Buffer.alloc(64 * 1024, 7));
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    await expect(left).toHaveText(
      '1 of 2 video or audio uploads left this week.',
    );

    const other = info.outputPath('other.mp4');
    writeFileSync(other, Buffer.alloc(64 * 1024, 8));
    await page.getByLabel('Choose another file').setInputFiles(other);
    await expect(page.getByText(/^Uploaded: other\.mp4/)).toBeVisible();
    await expect(left).toContainText('You’ve used this week’s 2 uploads');
    await expect(page.getByLabel('Choose another file')).toBeDisabled();
  });

  test('back on Choose after the upload that filled the open drafts, the new draft is offered to carry on', async ({
    page,
    request,
  }, info) => {
    await person(page, request, { settings: { openDraftsMax: 1 } });
    await page.goto(SHARE);
    await pick(page, 'Upload a video file');
    await page.getByRole('button', { name: 'Share my video' }).click();
    await page.getByRole('button', { name: 'Upload my video' }).click();
    await page.getByLabel('Title').fill('My new video');
    const path = info.outputPath('clip.mp4');
    writeFileSync(path, Buffer.alloc(64 * 1024, 7));
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(thisWeek(page)).toContainText('You have a draft on the go');
    // Choose starts again at Written: a new story of any kind waits.
    await expect(
      page.getByRole('button', { name: 'Write my story' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Continue “My new video”' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeFocused();
    await expect(page.getByLabel('Title')).toHaveValue('My new video');
  });

  test('with no uploads left, a dropped file waits too: nothing is asked for', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      stories: [story('vid', { title: 'My video', primaryFormat: 'video' })],
      uploadsAgo: [1, 2, 3, 4, 5].map((d) => d * DAY),
    });
    await page.goto(`${SHARE}?draft=vid`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeVisible();
    await expect(page.getByLabel('Choose a file')).toBeDisabled();
    const dropped = await page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.items.add(
        new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' }),
      );
      return t;
    });
    await page.dispatchEvent('[data-drop-zone]', 'drop', {
      dataTransfer: dropped,
    });
    await expect(
      page.getByRole('alert').filter({ hasText: 'uploads' }),
    ).toHaveText(
      /^You’ve started as many uploads as you can for now\. Your story is saved: you can upload your video from \w+day \d+ \w+ at \d+:\d\d\.$/,
    );
    await expect(page.locator('[data-upload-phase]')).toHaveAttribute(
      'data-upload-phase',
      'idle',
    );
    expect(await me.uploadRequests()).toBe(0);
  });

  test('when the numbers on the page went stale, the server’s refusal is explained and the story is kept', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      settings: { submissionsPer7Days: 2, openDraftsMax: 3 },
      stories: [submitted('sent', 1), story('b')],
    });
    await page.goto(SHARE);
    await expect(thisWeek(page)).toContainText(
      '1 of 2 stories left to send for review this week.',
    );

    // Submitting: this week's last submission was taken meanwhile.
    await page.getByRole('button', { name: 'Continue “Draft b”' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await me.settings({ submissionsPer7Days: 1 });
    const submit = page.getByRole('button', { name: 'Submit for review' });
    await submit.click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'for review' }),
    ).toContainText(
      'You’ve sent as many stories for review as you can this week. Your story is saved as a draft: you can submit it from',
    );
    // The page's numbers follow: submitting now waits, and says until when.
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(FROM);
    await page.getByRole('button', { name: 'Change your story' }).click();
    await expect(page.getByLabel('Your story')).toHaveValue(TEXT);

    // A new story: the open drafts filled meanwhile.
    await page.goto(SHARE);
    await expect(
      page.getByRole('button', { name: 'Write my story' }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Write my story' }).click();
    await page.getByRole('button', { name: 'Start writing' }).click();
    await me.settings({ openDraftsMax: 1 });
    await page.getByLabel('Title').fill('Not lost');
    await page.getByLabel('Your story').fill(TEXT);
    const saved = page.locator('[data-save-state]');
    await expect(saved).toHaveAttribute('data-save-state', 'error');
    await expect(saved).toHaveText(
      'You already have as many drafts open as you can. Continue one of them, or submit one first.',
    );
    await expect(page.getByLabel('Title')).toHaveValue('Not lost');
    await expect(page.getByLabel('Your story')).toHaveValue(TEXT);
    // Kept on this device: once there's room again, it saves.
    await me.settings({ openDraftsMax: 3 });
    await page.getByRole('button', { name: 'Try saving again' }).click();
    await expect(saved).toHaveText('Saved');
  });

  test('with this week’s submission sent and the open drafts full, a new story and submitting wait, and say until when', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      settings: { submissionsPer7Days: 1, openDraftsMax: 3 },
      stories: [
        submitted('sent', 1),
        story('b'),
        story('c'),
        story('d'),
        // Sent back for changes: sending it again isn't a new submission.
        story('back', {
          title: 'Sent back',
          status: 'changes_requested',
          submittedAt: new Date(Date.now() - 9 * DAY).toISOString(),
        }),
      ],
    });
    await page.goto(SHARE);
    const box = thisWeek(page);
    await expect(box).toContainText(
      'You’ve sent your story for review this week, which is all for now.',
    );
    await expect(box).toContainText(FROM);
    await expect(box).toContainText(
      'You have 3 drafts on the go, which is as many as you can keep at once.',
    );
    const start = page.getByRole('button', { name: 'Write my story' });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(/3 drafts on the go/);

    // A draft carries on, but submitting it waits.
    await page.getByRole('button', { name: 'Continue “Draft b”' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const submit = page.getByRole('button', { name: 'Submit for review' });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(
      /all for now\. You can send another from .*saved as a draft/,
    );

    // A story sent back for changes is submitted as usual.
    await page.goto(`${SHARE}?draft=back`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'Thank you for sharing your story',
      }),
    ).toBeVisible();
  });
});

test('at 200% text on a 320 px phone, the limits and their waits fit and stay tappable', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'phone-320', 'the smallest phone');
  await enlargeText(page);
  await person(page, request, {
    settings: { openDraftsMax: 1 },
    stories: [submitted('sent', 1), story('one')],
    uploadsAgo: [1, 2, 3, 4, 5].map((d) => d * DAY),
  });
  await page.goto(SHARE);
  await pick(page, 'Upload a video file');
  await expect(thisWeek(page)).toContainText('You have a draft on the go');
  await expect(thisWeek(page)).toContainText('this week’s 5 uploads');
  await expect(thisWeek(page)).toContainText('Videos: MP4, MOV or WebM');
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});
