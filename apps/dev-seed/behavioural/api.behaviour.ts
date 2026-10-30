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

test('serves dev’s placeholder privacy policy, terms of use and consent forms (D75, D93, D121, D122)', async ({
  request,
}) => {
  const dpa = await request.get(`${API_URL}/v1/legal/dpa`);
  expect(dpa.status()).toBe(200);
  const { current } = await dpa.json();
  expect(current).toMatchObject({ id: 'dev_placeholder', status: 'published' });
  expect(current.text).toContain('NOT LEGAL TEXT');
  // D121: the two legal documents, each in force with its PDF of record.
  for (const document of ['privacy', 'terms']) {
    const res = await request.get(`${API_URL}/v1/legal/documents/${document}`);
    expect(res.status(), document).toBe(200);
    const body = await res.json();
    expect(body.current, document).toMatchObject({ id: 'dev_placeholder' });
    expect(body.current.pdf?.sha256, document).toMatch(/^[0-9a-f]{64}$/);
    const pdf = await request.get(
      `${API_URL}/v1/legal/documents/${document}/versions/dev_placeholder.pdf`,
    );
    expect([document, pdf.status(), pdf.headers()['content-type']]).toEqual([
      document,
      200,
      'application/pdf',
    ]);
  }
  for (const form of ['signup', 'testimony', 'social']) {
    const res = await request.get(`${API_URL}/v1/legal/forms/${form}`);
    expect(res.status(), form).toBe(200);
    const body = await res.json();
    expect(body, form).toMatchObject({ form, id: 'v2' });
    const boxes = body.boxes.map((b: { statement: string }) => b.statement);
    // 18+ is asked at sign-up only (D93), with the terms box (D122).
    expect([form, boxes.includes('age_18plus')]).toEqual([
      form,
      form === 'signup',
    ]);
    expect([form, boxes.includes('terms_of_use')]).toEqual([
      form,
      form === 'signup',
    ]);
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
