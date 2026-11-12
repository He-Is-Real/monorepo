import type { Dataset, StoryFixture, StoryStatus } from './dataset';
import {
  type BunnyMedia,
  CLIPS,
  type ClipId,
  DEFAULT_AUDIO_THUMBNAIL,
  IMAGES,
  type ImageId,
  imagePath,
} from './media';

/** The schema's limits (libs/database/schema/schema-0*.surql), checked before anything is written. */
export const LIMITS = {
  titleMax: 140,
  descriptionMax: 5000,
  bodyMax: 10_000, // A3
  bodyMinSubmitted: 200, // once sent (pending, approved)
  themesMax: 5, // the default themesMax: every seeded story can be submitted
  themeNameMax: 40,
  altMax: 500,
} as const;

const SUBMITTED: StoryStatus[] = ['pending', 'approved', 'editing'];
/** A made-up Bunny video id, clearly no real one (StoryFixture.media.placeholder). */
const PLACEHOLDER = /^00000000-0000-0000-0000-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One entry of a story's status log on the way to its final status (R6), as the person or a
 * moderator would add it: who (`actor`), when (`at`) and the moderator's note to the person.
 */
export interface Step {
  /** The status log action (R6; Story states, Joel 2026-11-11). */
  action: 'sent' | 'editStarted' | 'approved' | 'rejected' | 'changesRequested';
  actor: 'person' | 'moderator';
  /** The moderator's feedback to the author (a changes request's or rejection's comment). */
  comment?: string;
  at: Date;
}

/** The variables the seed script binds (seed.ts). No secrets, no SurrealQL text. */
export interface SeedVars {
  people: string[];
  /** D112: Clerk user ids of dev's test accounts, marked trusted submitters. */
  testAccounts: string[];
  /** Plan 4e: Clerk user ids of dev's test accounts put back to never having agreed. */
  newcomerAccounts: string[];
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
    /** The draft as its author creates it: its content. */
    draft: Record<string, unknown>;
    /**
     * Its uploads (R12): each a storyFile row of its own (a story points only at its own rows):
     * its key (the Bunny video id, a placeholder's made-up id, or the picture's path) and fields.
     */
    media?: { key: string; row: Record<string, unknown> };
    image?: { key: string; row: Record<string, unknown>; alt?: string };
    steps: Step[];
    /** Approved stories: their approved entry's publishedAt (browse order). */
    publishedAt?: Date;
  }[];
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The status log from draft to a story's final status, an hour apart, the last one at `end`
 * (an approved story's: its publish date).
 */
export function stepsFor(story: StoryFixture, end: Date): Step[] {
  const reviews = story.reviews ?? [];
  const steps: Omit<Step, 'at'>[] = [];
  if (story.status === 'draft') return [];
  steps.push({ action: 'sent', actor: 'person' });
  for (const review of reviews) {
    const decision = {
      approve: 'approved',
      reject: 'rejected',
      request_changes: 'changesRequested',
    } as const;
    steps.push(
      compact({
        action: decision[review.decision],
        actor: 'moderator' as const,
        comment: review.feedback,
      }),
    );
    // After a request for changes, the author resubmits before the next decision.
    if (
      review.decision === 'request_changes' &&
      review !== reviews[reviews.length - 1]
    ) {
      steps.push({ action: 'sent', actor: 'person' });
    }
  }
  // Edit (ED-1, ED-4): taken down by its owner, from pending or published.
  if (story.status === 'editing')
    steps.push({ action: 'editStarted', actor: 'person' });
  return steps.map((step, i) => ({
    ...step,
    at: new Date(end.getTime() - (steps.length - 1 - i) * HOUR_MS),
  }));
}

/** Everything wrong with the dataset (and the uploads it needs), or an empty list. */
export function datasetProblems(data: Dataset, media: BunnyMedia): string[] {
  const problems: string[] = [];
  const themeKeys = new Set(data.themes.map((t) => t.key));
  const categoryKeys = new Set(['other', ...data.categories.map((c) => c.key)]);
  const people = new Set(data.people);
  const ids = new Set<string>();
  const slugs = new Set<string>();
  /** Each storyFile row's story: a clip's or picture's upload, or a placeholder id. */
  const files = new Map<string, string>();

  if (people.has(data.moderator))
    problems.push('the moderator is also a submitter');
  for (const id of [...data.people, data.moderator]) {
    if (!/^seed_[a-z0-9_]+$/.test(id))
      problems.push(`person ${id}: ids start with seed_`);
  }
  for (const clerk of data.newcomerAccounts) {
    if (data.testAccounts.includes(clerk))
      problems.push(`${clerk}: a newcomer account can't also have agreed`);
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
      sent_back: 'request_changes',
    };
    if (s.status in expected && last !== expected[s.status]) {
      p(`a ${s.status} story's last review is ${expected[s.status]}`);
    }
    if (['draft', 'pending'].includes(s.status) && reviews.length > 0) {
      p(`a ${s.status} story has no reviews here`);
    }
    // Edit is pressed on a story waiting for review or published (ED-1, ED-4).
    if (s.status === 'editing' && last !== undefined && last !== 'approve') {
      p('an editing story was taken down while pending or published');
    }
    if (reviews.slice(0, -1).some((r) => r.decision !== 'request_changes')) {
      p('only a request for changes comes before the last review');
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

    // R12: a story points only at its own storyFile rows, so each upload belongs to one story;
    // another story with the same clip uses a placeholder of its own, and is never public.
    const placeholder = s.media?.placeholder;
    if (placeholder !== undefined) {
      if (!PLACEHOLDER.test(placeholder))
        p(`placeholder ${placeholder} isn't 00000000-0000-0000-0000-<12 hex>`);
      if (s.status === 'approved') p('a placeholder file is never public');
    }
    const key = placeholder ?? (s.media && `clip ${s.media.clip}`);
    for (const k of [key, s.image && `image ${s.image.file}`]) {
      if (!k) continue;
      if (files.has(k)) p(`${k} is already ${files.get(k)}'s`);
      else files.set(k, s.id);
    }
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
    newcomerAccounts: data.newcomerAccounts,
    moderator: data.moderator,
    categories: data.categories.map(({ id, name }) => ({ id, name })),
    themes: data.themes.map((t) => ({
      id: t.id,
      name: t.name,
      category:
        data.categories.find((c) => c.key === t.category)?.id ?? 'other',
      highlighted: t.highlighted === true,
    })),
    stories: data.stories.map((s) => {
      const publishedAt =
        s.publishedDaysAgo === undefined
          ? undefined
          : new Date(now.getTime() - s.publishedDaysAgo * DAY_MS);
      return {
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
        }),
        media: s.media
          ? mediaFile(
              s.media.clip,
              media,
              s.media.processing,
              s.media.placeholder,
            )
          : undefined,
        image: s.image
          ? compact({
              ...imageFile(s.image.file, media, s.image.processing),
              alt: s.image.alt,
            })
          : undefined,
        steps: stepsFor(s, publishedAt ?? now),
        publishedAt,
      };
    }),
  };
}

/**
 * A clip's storyFile row: what processing would have recorded for it (R12). With a placeholder
 * (a story never public): a row of its own under that made-up id, with the clip's facts only once
 * processed, and its thumbnail's path under that id (nothing is there at Bunny).
 */
function mediaFile(
  clip: ClipId,
  media: BunnyMedia,
  processing?: string,
  placeholder?: string,
) {
  const uploaded = media.clips[clip];
  if (!uploaded) throw new Error(`${clip} hasn't been uploaded`);
  const kind = CLIPS[clip].kind;
  const facts = placeholder === undefined || processing !== undefined;
  const key = placeholder ?? uploaded.videoId;
  const thumbnail = uploaded.thumbnailPath?.split('/').pop();
  return {
    key,
    row: compact({
      format: kind,
      contentType: kind === 'video' ? 'video/mp4' : 'audio/mpeg',
      // The dummy files' sizes aren't recorded; nothing reads them for dev-seed's rows.
      sizeBytes: 1,
      storyVersion: 1,
      ...(facts
        ? {
            thumbnailPath:
              placeholder === undefined
                ? uploaded.thumbnailPath
                : thumbnail && `${key}/${thumbnail}`,
            width: uploaded.width,
            height: uploaded.height,
            lengthSeconds: uploaded.durationSeconds,
          }
        : {}),
      processing,
    }),
  };
}

/** A picture's storyFile row (R12): its path is the key. */
function imageFile(file: ImageId, media: BunnyMedia, processing?: string) {
  const uploaded = media.images[file];
  if (!uploaded) throw new Error(`${file} hasn't been uploaded`);
  return {
    key: uploaded.path,
    row: compact({
      format: 'image',
      contentType: 'image/webp',
      sizeBytes: 1,
      storyVersion: 1,
      width: uploaded.width,
      height: uploaded.height,
      processing,
    }),
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
