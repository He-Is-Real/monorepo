import type {
  Dataset,
  ReviewFixture,
  StoryFixture,
  StoryStatus,
} from './dataset';
import {
  type BunnyMedia,
  CLIPS,
  type ClipId,
  DEFAULT_AUDIO_THUMBNAIL,
  IMAGES,
  type ImageId,
  imagePath,
} from './media';

/** The schema's limits (libs/database/schema/schema.surql), checked before anything is written. */
export const LIMITS = {
  titleMax: 140,
  descriptionMax: 5000,
  bodyMax: 10_000, // A3
  bodyMinSubmitted: 200, // from submit on (pending, in_review, approved)
  themesMax: 5, // the default themesMax: every seeded story can be submitted
  themeNameMax: 40,
  altMax: 500,
} as const;

const SUBMITTED: StoryStatus[] = ['pending', 'in_review', 'approved'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** One update on the way to a story's final status, as the services would make it. */
export interface Step {
  status: StoryStatus;
  /** A moderator picks it up (lockedBy/lockedAt). */
  lock?: true;
  /** The moderator's feedback to the author (rejectionFeedback). */
  feedback?: string;
  /** The decision recorded before this update (moderationReview). */
  review?: ReviewFixture;
}

/** The variables the seed script binds (seed.ts). No secrets, no SurrealQL text. */
export interface SeedVars {
  people: string[];
  /** D112: Clerk user ids of dev's test accounts, marked trusted submitters. */
  testAccounts: string[];
  moderator: string;
  categories: { id: string; name: string }[];
  themes: {
    id: string;
    name: string;
    category: string;
    highlighted: boolean;
  }[];
  stories: {
    id: string;
    /** user:<id> */
    submitter: string;
    /** The draft as its author creates it: content and uploads. */
    draft: Record<string, unknown>;
    steps: Step[];
    /** Approved stories: publicStory.publishedAt and story.approvedAt. */
    publishedAt?: Date;
  }[];
}

/** The moves from draft to a story's final status. */
export function stepsFor(story: StoryFixture): Step[] {
  const reviews = story.reviews ?? [];
  const steps: Step[] = [];
  if (story.status === 'draft') return steps;
  steps.push({ status: 'pending' });
  for (const review of reviews) {
    steps.push({ status: 'in_review', lock: true });
    switch (review.decision) {
      case 'approve':
        steps.push({ status: 'approved', review });
        break;
      case 'reject':
        steps.push({ status: 'rejected', review, feedback: review.feedback });
        break;
      case 'request_changes':
        steps.push({
          status: 'changes_requested',
          review,
          feedback: review.feedback,
        });
        break;
      case 'escalate':
        // Stays in review, still locked by the moderator.
        steps.push({ status: 'in_review', lock: true, review });
        break;
    }
    // After a request for changes, the author resubmits before the next decision.
    const last = steps[steps.length - 1];
    if (
      last.status === 'changes_requested' &&
      review !== reviews[reviews.length - 1]
    ) {
      steps.push({ status: 'pending' });
    }
  }
  if (
    story.status === 'in_review' &&
    steps[steps.length - 1].status !== 'in_review'
  ) {
    steps.push({ status: 'in_review', lock: true });
  }
  if (story.status === 'withdrawn') steps.push({ status: 'withdrawn' });
  return steps;
}

/** Everything wrong with the dataset (and the uploads it needs), or an empty list. */
export function datasetProblems(data: Dataset, media: BunnyMedia): string[] {
  const problems: string[] = [];
  const themeKeys = new Set(data.themes.map((t) => t.key));
  const categoryKeys = new Set(['other', ...data.categories.map((c) => c.key)]);
  const people = new Set(data.people);
  const ids = new Set<string>();
  const slugs = new Set<string>();

  if (people.has(data.moderator))
    problems.push('the moderator is also a submitter');
  for (const id of [...data.people, data.moderator]) {
    if (!/^seed_[a-z0-9_]+$/.test(id))
      problems.push(`person ${id}: ids start with seed_`);
  }
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  for (const t of [...data.categories, ...data.themes]) {
    if (!ULID.test(t.id)) problems.push(`${t.key}: its id isn't a ULID`);
    if (t.name.length === 0 || t.name.length > LIMITS.themeNameMax) {
      problems.push(`${t.key}: name length`);
    }
  }
  for (const t of data.themes) {
    if (!categoryKeys.has(t.category))
      problems.push(`${t.key}: unknown category ${t.category}`);
  }

  for (const s of data.stories) {
    const p = (m: string) => problems.push(`${s.id}: ${m}`);
    if (!/^seed_[a-z0-9_]+$/.test(s.id)) p('ids start with seed_');
    if (ids.has(s.id)) p('duplicate id');
    if (slugs.has(s.slug)) p('duplicate slug');
    ids.add(s.id);
    slugs.add(s.slug);
    if (!people.has(s.submitter)) p(`unknown submitter ${s.submitter}`);
    if (s.title.length === 0 || s.title.length > LIMITS.titleMax)
      p('title length');
    if (s.description.length > LIMITS.descriptionMax) p('description too long');
    if (s.themes.length > LIMITS.themesMax) p('more than 5 themes');
    if (s.status !== 'draft' && s.themes.length === 0)
      p('a submitted story needs a theme (themesMin)');
    for (const t of s.themes) if (!themeKeys.has(t)) p(`unknown theme ${t}`);
    if (new Set(s.themes).size !== s.themes.length) p('a theme twice');

    const body = s.body?.trim() ?? '';
    if ((s.body?.length ?? 0) > LIMITS.bodyMax)
      p('body over 10,000 characters');
    if (s.format === 'written') {
      if (body.length === 0) p('a written story needs its text');
      if (
        SUBMITTED.includes(s.status) &&
        body.length < LIMITS.bodyMinSubmitted
      ) {
        p('a submitted written story needs at least 200 characters');
      }
      if (s.media) p('a written story has no video or audio');
    } else {
      if (!s.media && s.status !== 'draft')
        p(`a ${s.format} story needs its ${s.format} once submitted`);
      if (s.media && CLIPS[s.media.clip].kind !== s.format)
        p(`${s.media.clip} isn't ${s.format}`);
    }
    if ((s.image?.alt?.length ?? 0) > LIMITS.altMax) p('alt text too long');

    // A2: approval needs every upload processed.
    if (s.status === 'approved') {
      if (s.media && s.media.processing !== 'ready')
        p("approved, but its media isn't ready");
      if (s.image && s.image.processing !== 'ready')
        p("approved, but its image isn't ready");
      if (s.publishedDaysAgo === undefined || s.publishedDaysAgo < 0)
        p('approved needs publishedDaysAgo');
    } else if (s.publishedDaysAgo !== undefined) {
      p('only approved stories are published');
    }

    const reviews = s.reviews ?? [];
    const last = reviews[reviews.length - 1]?.decision;
    const expected: Partial<Record<StoryStatus, string | undefined>> = {
      approved: 'approve',
      rejected: 'reject',
      changes_requested: 'request_changes',
    };
    if (s.status in expected && last !== expected[s.status]) {
      p(`a ${s.status} story's last review is ${expected[s.status]}`);
    }
    if (
      ['draft', 'pending', 'withdrawn'].includes(s.status) &&
      reviews.length > 0
    ) {
      p(`a ${s.status} story has no reviews here`);
    }
    if (
      s.status === 'in_review' &&
      reviews.some((r) => r.decision !== 'escalate')
    ) {
      p('an in_review story has only escalations');
    }
    if (
      reviews
        .slice(0, -1)
        .some(
          (r) => r.decision !== 'request_changes' && r.decision !== 'escalate',
        )
    ) {
      p(
        'only a request for changes or an escalation comes before the last review',
      );
    }
    for (const r of reviews) {
      if (
        (r.decision === 'reject' || r.decision === 'request_changes') &&
        !r.feedback
      ) {
        p(`${r.decision} needs pastoral feedback`);
      }
    }

    // Every upload a story uses (past its draft) must have been uploaded once (upload.ts).
    if (s.media && !media.clips[s.media.clip])
      p(`${s.media.clip} hasn't been uploaded (bunny-media.json)`);
    if (s.image && !media.images[s.image.file])
      p(`${s.image.file} hasn't been uploaded (bunny-media.json)`);
  }
  return problems;
}

/** The variables for the seed script. Throws if the dataset or its uploads have a problem. */
export function buildVars(
  data: Dataset,
  media: BunnyMedia,
  now = new Date(),
): SeedVars {
  const problems = datasetProblems(data, media);
  if (problems.length > 0) {
    throw new Error(
      `The dev dataset has problems:\n  ${problems.join('\n  ')}`,
    );
  }
  return {
    people: data.people,
    testAccounts: data.testAccounts,
    moderator: data.moderator,
    categories: data.categories.map(({ id, name }) => ({ id, name })),
    themes: data.themes.map((t) => ({
      id: t.id,
      name: t.name,
      category:
        data.categories.find((c) => c.key === t.category)?.id ?? 'other',
      highlighted: t.highlighted === true,
    })),
    stories: data.stories.map((s) => ({
      id: s.id,
      submitter: s.submitter,
      draft: compact({
        slug: s.slug,
        title: s.title,
        description: s.description,
        body: s.body,
        bylineName: s.bylineName,
        primaryFormat: s.format,
        themeRefs: s.themes.map(
          (key) => data.themes.find((t) => t.key === key)?.id,
        ),
        media: s.media
          ? [mediaItem(s.media.clip, media, s.media.processing)]
          : [],
        image: s.image
          ? compact({
              ...imageFields(s.image.file, media),
              alt: s.image.alt,
              processing: s.image.processing,
            })
          : undefined,
      }),
      steps: stepsFor(s),
      publishedAt:
        s.publishedDaysAgo === undefined
          ? undefined
          : new Date(now.getTime() - s.publishedDaysAgo * DAY_MS),
    })),
  };
}

function mediaItem(clip: ClipId, media: BunnyMedia, processing?: string) {
  const uploaded = media.clips[clip];
  if (!uploaded) throw new Error(`${clip} hasn't been uploaded`);
  return compact({
    format: CLIPS[clip].kind,
    bunnyVideoId: uploaded.videoId,
    thumbnailPath: uploaded.thumbnailPath,
    width: uploaded.width,
    height: uploaded.height,
    durationSeconds: uploaded.durationSeconds,
    processing,
  });
}

function imageFields(file: ImageId, media: BunnyMedia) {
  const uploaded = media.images[file];
  if (!uploaded) throw new Error(`${file} hasn't been uploaded`);
  return {
    path: uploaded.path,
    width: uploaded.width,
    height: uploaded.height,
  };
}

/** Drops undefined keys: an absent field is NONE in SurrealDB, while null would be NULL. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Stand-in uploads for tests: what upload.ts would record, from the media spec's own sizes.
 * Never used against dev (the seed reads bunny-media.json there).
 */
export function fakeUploads(): BunnyMedia {
  return {
    libraryId: 'test-library',
    clips: Object.fromEntries(
      Object.entries(CLIPS).map(([id, c]) => [
        id,
        compact({
          videoId: `test-video-${id}`,
          // Audio: the site's default thumbnail, a custom upload (upload.ts).
          thumbnailPath:
            c.kind === 'video'
              ? `test-video-${id}/thumbnail.jpg`
              : `test-video-${id}/thumbnail_0a1b2c3d.jpg`,
          width: 'width' in c ? c.width : DEFAULT_AUDIO_THUMBNAIL.width,
          height: 'height' in c ? c.height : DEFAULT_AUDIO_THUMBNAIL.height,
          durationSeconds: c.durationSeconds,
        }),
      ]),
    ),
    images: Object.fromEntries(
      Object.entries(IMAGES).map(([id, i]) => [
        id,
        { path: imagePath(id as ImageId), width: i.width, height: i.height },
      ]),
    ),
  };
}
