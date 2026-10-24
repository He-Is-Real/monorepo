import { CLIPS, IMAGES, MAX_CLIP_SECONDS } from '../media';
import { datasetProblems, fakeUploads, LIMITS } from '../plan';
import { DATASET } from './index';
import { dummyText } from './text';

// D47's composition: the dataset must keep covering it as it grows.
describe('the D47 dummy dataset', () => {
  const stories = DATASET.stories;
  const count = (f: (s: (typeof stories)[number]) => boolean) =>
    stories.filter(f).length;

  it('has no problems the schema would refuse', () => {
    expect(datasetProblems(DATASET, fakeUploads())).toEqual([]);
  });

  it('covers every story type, with and without its optional part', () => {
    const video = stories.filter((s) => s.format === 'video');
    const audio = stories.filter((s) => s.format === 'audio');
    const written = stories.filter((s) => s.format === 'written');
    expect(video.length).toBeGreaterThanOrEqual(10);
    expect(audio.length).toBeGreaterThanOrEqual(2);
    expect(written.length).toBeGreaterThanOrEqual(10);
    expect(video.some((s) => s.body) && video.some((s) => !s.body)).toBe(true);
    expect(audio.some((s) => s.body) && audio.some((s) => !s.body)).toBe(true);
    expect(written.filter((s) => s.image).length).toBeGreaterThanOrEqual(4);
    expect(written.filter((s) => !s.image).length).toBeGreaterThanOrEqual(5);
  });

  it('covers the video shapes: 9:16, 9:19.5, 16:9, 2.4:1 and square', () => {
    const shapes = new Set(
      stories.flatMap((s) => {
        const c = s.media ? CLIPS[s.media.clip] : undefined;
        return c && c.kind === 'video' ? [`${c.width}x${c.height}`] : [];
      }),
    );
    expect([...shapes].sort()).toEqual([
      '360x640',
      '360x780',
      '480x480',
      '640x360',
      '768x320',
    ]);
  });

  it('covers every moderation state, about 14 approved', () => {
    const by = (status: string) => count((s) => s.status === status);
    expect(by('approved')).toBeGreaterThanOrEqual(14);
    expect(by('pending')).toBeGreaterThanOrEqual(2);
    expect(by('in_review')).toBeGreaterThanOrEqual(2);
    expect(by('changes_requested')).toBeGreaterThanOrEqual(2);
    expect(by('rejected')).toBeGreaterThanOrEqual(1);
    expect(by('withdrawn')).toBeGreaterThanOrEqual(1);
    expect(by('draft')).toBeGreaterThanOrEqual(1);
    // Sent back once, then approved: a review history longer than one decision.
    expect(
      stories.some(
        (s) => s.status === 'approved' && (s.reviews?.length ?? 0) > 1,
      ),
    ).toBe(true);
  });

  it('covers the edge cases', () => {
    expect(count((s) => s.bylineName === undefined)).toBeGreaterThanOrEqual(1);
    expect(
      count((s) => s.title.length === LIMITS.titleMax),
    ).toBeGreaterThanOrEqual(1);
    expect(count((s) => s.tags.length === 0)).toBeGreaterThanOrEqual(1);
    expect(
      count((s) => s.tags.length === LIMITS.tagsMax),
    ).toBeGreaterThanOrEqual(1);
    expect(
      count((s) =>
        /\p{Script=Greek}|\p{Script=Hangul}|\p{Script=Arabic}/u.test(s.title),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(count((s) => s.description.length > 4000)).toBeGreaterThanOrEqual(1);
  });

  it('has written stories at the 10,000 maximum, at the 200 minimum and one short draft', () => {
    const written = stories.filter((s) => s.format === 'written');
    expect(written.some((s) => s.body?.length === LIMITS.bodyMax)).toBe(true);
    expect(
      written.some(
        (s) =>
          s.status !== 'draft' &&
          s.body?.trim().length === LIMITS.bodyMinSubmitted,
      ),
    ).toBe(true);
    expect(
      written.some(
        (s) => s.status === 'draft' && (s.body?.trim().length ?? 0) < 200,
      ),
    ).toBe(true);
    // Every written story past its draft meets the minimum (also checked by datasetProblems).
    for (const s of written.filter((s) => s.status !== 'draft')) {
      expect(s.body?.trim().length ?? 0).toBeGreaterThanOrEqual(
        LIMITS.bodyMinSubmitted,
      );
    }
  });

  it('keeps the walking skeleton’s old slug published (old dev links)', () => {
    const skeleton = stories.find(
      (s) => s.slug === 'test-story-walking-skeleton',
    );
    expect(skeleton?.status).toBe('approved');
  });

  it('uses only the browse tags, in their three categories', () => {
    expect(new Set(DATASET.tags.map((t) => t.category))).toEqual(
      new Set(['theme', 'journey', 'emotion']),
    );
    for (const name of [
      'Healing',
      'Addiction',
      'Loss',
      'Depression',
      'Faith',
      'Answered Prayers',
      'Forgiveness',
      'Relationships',
      'Loneliness',
      'Salvation',
    ]) {
      expect(DATASET.tags.map((t) => t.name)).toContain(name);
    }
  });

  it('is obviously test content', () => {
    for (const s of stories) {
      const text = `${s.title} ${s.description} ${s.body ?? ''} ${s.bylineName ?? ''}`;
      expect(text).toMatch(/test|dummy|Test|Dummy|Δοκιμαστική/);
    }
  });
});

describe('the D47 media set', () => {
  it('keeps every clip at most 20 seconds long', () => {
    for (const c of Object.values(CLIPS)) {
      expect(c.durationSeconds).toBeGreaterThan(0);
      expect(c.durationSeconds).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
    }
  });

  it('keeps every picture within 1:3 and 3:1 (D53), with even video sizes', () => {
    const shapes = [
      ...Object.values(CLIPS).flatMap((c) =>
        'width' in c ? [[c.width, c.height]] : [],
      ),
      ...Object.values(IMAGES).map((i) => [i.width, i.height]),
    ];
    for (const [w, h] of shapes) {
      expect(h).toBeLessThanOrEqual(w * 3);
      expect(w).toBeLessThanOrEqual(h * 3);
    }
    for (const c of Object.values(CLIPS)) {
      if ('width' in c) expect([c.width % 2, c.height % 2]).toEqual([0, 0]);
    }
  });

  it('includes an image beyond the 2:1 card clamp', () => {
    expect(Object.values(IMAGES).some((i) => i.width / i.height > 2)).toBe(
      true,
    );
  });
});

describe('dummyText', () => {
  it.each([90, 200, 1234, 10_000])('is exactly %i characters, trimmed', (n) => {
    const t = dummyText(n);
    expect(t).toHaveLength(n);
    expect(t.trim()).toHaveLength(n);
  });
});
