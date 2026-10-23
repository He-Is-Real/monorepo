import { DATASET, type Dataset, type StoryFixture } from './dataset';
import bunnyMedia from './bunny-media.json';
import {
  type BunnyMedia,
  CLIPS,
  type ClipId,
  IMAGES,
  type ImageId,
} from './media';
import { buildVars, datasetProblems, fakeUploads, stepsFor } from './plan';

const story = (fields: Partial<StoryFixture>): StoryFixture => ({
  id: 'seed_x',
  slug: 'x',
  title: 'Test x',
  description: 'Dummy',
  body: 'b'.repeat(300),
  submitter: 'seed_ruth',
  format: 'written',
  tags: [],
  status: 'draft',
  ...fields,
});

const withStory = (s: StoryFixture): Dataset => ({ ...DATASET, stories: [s] });

describe('stepsFor', () => {
  it('leaves a draft as it is', () => {
    expect(stepsFor(story({}))).toEqual([]);
  });

  it('submits, picks up and approves', () => {
    expect(
      stepsFor(
        story({ status: 'approved', reviews: [{ decision: 'approve' }] }),
      ).map((s) => s.status),
    ).toEqual(['pending', 'in_review', 'approved']);
  });

  it('resubmits after a request for changes', () => {
    const steps = stepsFor(
      story({
        status: 'approved',
        reviews: [
          { decision: 'request_changes', feedback: 'f' },
          { decision: 'approve' },
        ],
      }),
    );
    expect(steps.map((s) => s.status)).toEqual([
      'pending',
      'in_review',
      'changes_requested',
      'pending',
      'in_review',
      'approved',
    ]);
    expect(steps[2]).toMatchObject({
      feedback: 'f',
      review: { decision: 'request_changes' },
    });
    expect(steps.filter((s) => s.lock)).toHaveLength(2);
  });

  it('keeps an escalated story in review, locked', () => {
    const steps = stepsFor(
      story({ status: 'in_review', reviews: [{ decision: 'escalate' }] }),
    );
    expect(steps.map((s) => [s.status, s.lock, s.review?.decision])).toEqual([
      ['pending', undefined, undefined],
      ['in_review', true, undefined],
      ['in_review', true, 'escalate'],
    ]);
  });

  it('picks up an in_review story without reviews', () => {
    expect(
      stepsFor(story({ status: 'in_review' })).map((s) => s.status),
    ).toEqual(['pending', 'in_review']);
  });

  it('withdraws after submitting', () => {
    expect(
      stepsFor(story({ status: 'withdrawn' })).map((s) => s.status),
    ).toEqual(['pending', 'withdrawn']);
  });
});

describe('datasetProblems', () => {
  const media = fakeUploads();
  const problems = (s: Partial<StoryFixture>) =>
    datasetProblems(withStory(story(s)), media);

  it.each<[string, Partial<StoryFixture>, string]>([
    [
      'a short submitted written story',
      { status: 'pending', body: 'x'.repeat(199) },
      'at least 200',
    ],
    ['text over 10,000', { body: 'x'.repeat(10_001) }, 'over 10,000'],
    ['a 141-character title', { title: 'x'.repeat(141) }, 'title length'],
    [
      'six tags',
      { tags: ['healing', 'loss', 'faith', 'joy', 'hope', 'peace'] },
      'more than 5',
    ],
    ['an unknown tag', { tags: ['nope'] }, 'unknown tag'],
    ['an unknown person', { submitter: 'seed_nobody' }, 'unknown submitter'],
    ['an id without seed_', { id: 'x' }, 'seed_'],
    [
      'a submitted video without its video',
      { format: 'video', status: 'pending', body: undefined },
      'needs its video',
    ],
    [
      'an image on a video',
      {
        format: 'video',
        media: { clip: 'clip-01' },
        image: { file: 'image-01' },
      },
      'only a written',
    ],
    [
      'audio as video',
      { format: 'video', media: { clip: 'clip-08' } },
      "isn't video",
    ],
    [
      'approval with unprocessed media',
      {
        format: 'video',
        media: { clip: 'clip-01' },
        status: 'approved',
        reviews: [{ decision: 'approve' }],
        publishedDaysAgo: 1,
      },
      "media isn't ready",
    ],
    [
      'approval with an unprocessed image',
      {
        image: { file: 'image-01' },
        status: 'approved',
        reviews: [{ decision: 'approve' }],
        publishedDaysAgo: 1,
      },
      "image isn't ready",
    ],
    [
      'approval without its review',
      { status: 'approved', publishedDaysAgo: 1 },
      'last review is approve',
    ],
    [
      'a rejection without feedback',
      { status: 'rejected', reviews: [{ decision: 'reject' }] },
      'pastoral feedback',
    ],
    ['a published draft', { publishedDaysAgo: 1 }, 'only approved'],
  ])('refuses %s', (_, fields, message) => {
    expect(problems(fields).join('\n')).toContain(message);
  });

  it('refuses media that was never uploaded', () => {
    const s = story({
      format: 'video',
      media: { clip: 'clip-01' },
      body: undefined,
    });
    expect(
      datasetProblems(withStory(s), { clips: {}, images: {} }).join(),
    ).toContain("clip-01 hasn't been uploaded");
  });

  it('accepts a short draft', () => {
    expect(problems({ body: 'short' })).toEqual([]);
  });
});

describe('the committed media record (bunny-media.json)', () => {
  it('covers every clip and image the dataset uses, as uploaded to the dev library', () => {
    expect(datasetProblems(DATASET, bunnyMedia as BunnyMedia)).toEqual([]);
    expect(() => buildVars(DATASET, bunnyMedia as BunnyMedia)).not.toThrow();
  });

  it('matches the media spec’s sizes and lengths (what Bunny reported)', () => {
    const media = bunnyMedia as BunnyMedia;
    for (const [id, clip] of Object.entries(CLIPS)) {
      const uploaded = media.clips[id as ClipId];
      expect(uploaded?.durationSeconds).toBe(clip.durationSeconds);
      if (clip.kind === 'video') {
        expect([uploaded?.width, uploaded?.height]).toEqual([
          clip.width,
          clip.height,
        ]);
      } else {
        expect(uploaded?.width).toBeUndefined();
      }
    }
    for (const [id, image] of Object.entries(IMAGES)) {
      expect(media.images[id as ImageId]).toEqual({
        path: `dev-seed/${id}.webp`,
        width: image.width,
        height: image.height,
      });
    }
  });
});

describe('buildVars', () => {
  it('refuses a dataset with problems, before anything connects', () => {
    expect(() => buildVars(DATASET, { clips: {}, images: {} })).toThrow(
      /hasn't been uploaded/,
    );
  });

  it('turns the dataset into bound variables: no undefined, no null', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    const vars = buildVars(DATASET, fakeUploads(), now);
    expect(vars.stories).toHaveLength(DATASET.stories.length);
    const json = JSON.stringify(vars);
    expect(json).not.toContain('null');
    const v01 = vars.stories.find((s) => s.id === 'seed_v01');
    expect(v01?.draft['media']).toEqual([
      {
        format: 'video',
        bunnyVideoId: 'test-video-clip-01',
        thumbnailPath: 'test-video-clip-01/thumbnail.jpg',
        width: 360,
        height: 640,
        durationSeconds: 12,
        processing: 'ready',
      },
    ]);
    expect(v01?.publishedAt).toEqual(new Date('2026-10-21T12:00:00Z'));
    const a01 = vars.stories.find((s) => s.id === 'seed_a01');
    expect(a01?.draft['media']).toEqual([
      expect.not.objectContaining({ width: expect.anything() }),
    ]);
    const w05 = vars.stories.find((s) => s.id === 'seed_w05');
    expect(w05?.draft['image']).toEqual({
      path: 'dev-seed/image-05.webp',
      width: 1080,
      height: 1350,
      alt: 'A portrait test pattern (dummy image)',
    });
  });
});
