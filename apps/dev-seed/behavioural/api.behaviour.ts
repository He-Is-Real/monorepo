import { expect, test } from '@playwright/test';
import { DATASET } from '../src/app/dataset';
import { API_URL } from './playwright.config';

// api-public-read on dev, after a reset: it serves exactly the approved dummy stories (D26),
// public through the fixture people's real agreements (plan 4e), and the four legal texts.
const approved = DATASET.stories.filter((s) => s.status === 'approved');
const unpublished = DATASET.stories.filter((s) => s.status !== 'approved');

test('reports the database up', async ({ request }) => {
  const res = await request.get(`${API_URL}/health`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ db: 'up' });
});

test('serves the four legal texts, each with its versions', async ({
  request,
}) => {
  for (const document of [
    'terms-of-use',
    'testimony-consent',
    'social-media-sharing-consent',
    'privacy-notice',
  ]) {
    const res = await request.get(`${API_URL}/v1/legal/documents/${document}`);
    expect(res.status(), document).toBe(200);
    const body = await res.json();
    expect(body, document).toMatchObject({
      document,
      latest: {
        version: expect.any(Number),
        releaseDate: expect.any(String),
        content: expect.any(String),
      },
    });
    expect(body.versions[0], document).toMatchObject({
      version: body.latest.version,
    });
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
