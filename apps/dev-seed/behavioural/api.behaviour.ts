import { expect, test } from '@playwright/test';
import { DATASET } from '../src/app/dataset';
import { API_URL } from './playwright.config';

// api-public-read on dev, after a reset: it serves exactly the approved dummy stories (D26),
// and says consent checks are relaxed (D48).
const approved = DATASET.stories.filter((s) => s.status === 'approved');
const unpublished = DATASET.stories.filter((s) => s.status !== 'approved');

test('reports the database up and consent checks relaxed (D48)', async ({
  request,
}) => {
  const res = await request.get(`${API_URL}/health`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    db: 'up',
    consentChecksRelaxed: true,
  });
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
