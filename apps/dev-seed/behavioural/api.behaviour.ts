import { expect, test } from '@playwright/test';
import { DATASET } from '../src/app/dataset';
import { API_URL } from './playwright.config';

// api-public-read on dev, after a reset: it serves exactly the approved dummy stories (D26)
// with consent checks enforced (D48 off since D75): the stories are public through the fixture
// people's real ledger consent on dev's placeholder forms, which it also serves.
const approved = DATASET.stories.filter((s) => s.status === 'approved');
const unpublished = DATASET.stories.filter((s) => s.status !== 'approved');

test('reports the database up and consent checks enforced (D48 off, D75)', async ({
  request,
}) => {
  const res = await request.get(`${API_URL}/health`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    db: 'up',
    consentChecksRelaxed: false,
  });
});

test('serves dev’s placeholder privacy document and consent forms (D75, D84, D93)', async ({
  request,
}) => {
  const dpa = await request.get(`${API_URL}/v1/legal/dpa`);
  expect(dpa.status()).toBe(200);
  const { current } = await dpa.json();
  expect(current).toMatchObject({ id: 'dev_placeholder', status: 'published' });
  expect(current.text).toContain('NOT LEGAL TEXT');
  for (const form of ['signup', 'testimony', 'social']) {
    const res = await request.get(`${API_URL}/v1/legal/forms/${form}`);
    expect(res.status(), form).toBe(200);
    const body = await res.json();
    expect(body, form).toMatchObject({ form, dpaVersion: 'dev_placeholder' });
    // 18+ is asked at sign-up only (D93).
    expect(body.text.includes('I am 18 or over'), form).toBe(form === 'signup');
  }
});

test('serves every approved story, with its media', async ({ request }) => {
  for (const story of approved) {
    const res = await request.get(`${API_URL}/v1/stories/${story.slug}`);
    expect(res.status(), story.id).toBe(200);
    const body = await res.json();
    expect(body, story.id).toMatchObject({
      slug: story.slug,
      title: story.title,
    });
    expect(body.media ?? [], story.id).toHaveLength(story.media ? 1 : 0);
  }
});

test('hides every story that isn’t approved', async ({ request }) => {
  for (const story of unpublished) {
    const res = await request.get(`${API_URL}/v1/stories/${story.slug}`);
    expect(res.status(), `${story.status} ${story.id}`).toBe(404);
  }
});
