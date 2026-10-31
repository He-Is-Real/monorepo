import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  DatabaseQueryError,
  type IdempotencyScope,
  isStoryTextTooShortError,
  requireWritten,
  retryOnConflict,
  runIdempotent,
  runQuery,
  storyLimitOf,
  SUBMISSION_SETTINGS_SQL,
  type SubmissionSettings,
  submissionLimitOf,
  trimmedTextLength,
} from '@heisreal/database';
import { recordKey } from '@heisreal/consent';
import type { SurrealQueryable } from 'surrealdb';
import type { MediaUrls } from '@heisreal/story-cards';
import {
  type CreateInput,
  slugFor,
  overLimit,
  slugSuffix,
  type StoryFields,
  textRequired,
  unknownTags,
} from './story-input';

/** The contract's `Tag`. */
export interface Tag {
  slug: string;
  name: string;
  category: 'theme' | 'journey' | 'emotion';
  version: number;
}

/** The contract's `StoryMine` (components.yaml). */
export interface StoryMine {
  id: string;
  version: number;
  slug: string;
  status: string;
  title: string;
  description: string;
  body: string | null;
  bylineName: string | null;
  primaryFormat: string;
  media: {
    format: string;
    playbackUrl: null;
    thumbnailUrl: null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    processing: string | null;
  }[];
  /** A written story's image or an audio story's picture (M2 plan PR 10), signed for its owner. */
  image: {
    url: string | null;
    width: number;
    height: number;
    alt: string | null;
  } | null;
  tags: Tag[];
  rejectionFeedback: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** A draft's deletion date if nobody touches it (D71; fn::story::draft_expires_at). */
  draftExpiresAt: string | null;
}

/** The contract's `SubmissionLimits`: what the submit page shows and checks (W3, D112). */
export interface SubmissionLimits {
  storyText: { min: number; max: number };
  tags: { min: number; max: number };
  openDrafts: { max: number | null; open: number };
  submissions: { per7Days: number | null; nextAvailableAt: string | null };
  uploads: {
    videoMaxBytes: number;
    audioMaxBytes: number;
    maxDurationSeconds: number;
    perHour: number;
    per7Days: number | null;
    nextAvailableAt: string | null;
  };
}

export interface CommandResult {
  id: string;
  version: number;
}

/** 412: `If-Match` isn't the story's version (D29). */
export class StaleVersionException extends HttpException {
  constructor() {
    super(
      {
        code: 'stale_version',
        message:
          'The story changed since you read it: read it again and re-apply your change',
      },
      HttpStatus.PRECONDITION_FAILED,
    );
  }
}

/** 428: `If-Match` is missing (our client's bug, never the person's). */
export class IfMatchRequiredException extends HttpException {
  constructor() {
    super(
      {
        code: 'if_match_required',
        message: 'This command needs If-Match with the story’s version',
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
}

const CATEGORY_ORDER = ['theme', 'journey', 'emotion'];
const EDITABLE = ['draft', 'changes_requested'];
/** Codes the commands THROW inside their transaction, read back from the error. */
const ERR =
  /\bstory_cmd:(not_found|stale_version|locked|unknown_tag|not_written|not_withdrawable|not_deletable)\b/;
/** WithdrawStory: anything submitted and not yet finished with (D61: withdrawn stays withdrawn). */
const WITHDRAWABLE = ['pending', 'in_review', 'approved', 'changes_requested'];
/**
 * DeleteStory (D71): the person's own draft, withdrawn or rejected story, or one sent back for
 * changes (no need to withdraw it first). The database's story permission says the same, so it
 * holds whoever calls.
 */
const DELETABLE = ['draft', 'changes_requested', 'withdrawn', 'rejected'];

interface RawStory {
  id: string;
  version: number;
  slug: string;
  status: string;
  title: string;
  description: string;
  body?: string | null;
  bylineName?: string | null;
  primaryFormat: string;
  tagRefs: string[];
  media?: {
    format: string;
    width?: number | null;
    height?: number | null;
    durationSeconds?: number | null;
    processing?: string | null;
  }[];
  image?: { path: string; width: number; height: number; alt?: string } | null;
  rejectionFeedback?: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  draftExpiresAt?: string | null;
}

const STORY_FIELDS = `<string> id AS id, version, slug, status, title, description, body,
  bylineName, primaryFormat, tagRefs.map(|$t| <string> $t) AS tagRefs, media, image, rejectionFeedback,
  submittedAt, approvedAt, createdAt, updatedAt, fn::story::draft_expires_at(id) AS draftExpiresAt`;

function fail400(pointer: string, message: string): never {
  throw new BadRequestException({
    code: 'validation_failed',
    message: 'The story has fields that aren’t valid',
    errors: [{ pointer, message }],
  });
}

const iso = (d: string | null | undefined) =>
  d ? new Date(d).toISOString() : null;

/**
 * The person's own stories: reads and the submit-flow commands (CreateDraftStory, EditStory,
 * SubmitStory), all in the person's own database session (D27), so the database checks
 * ownership, consent (D21, D93), the story's shape and text limits (D53, A3) and D94's limits.
 */
export class StoryStore {
  constructor(
    private readonly person: SurrealQueryable,
    /** Signs the draft's image for its owner (D52); its URL is null without it. */
    private readonly urls?: Pick<MediaUrls, 'imageUrl'>,
  ) {}

  async tags(): Promise<Tag[]> {
    const [rows] = (await runQuery(
      this.person,
      'SELECT record::id(id) AS slug, name, category, version FROM tag',
    )) as [Tag[]];
    return rows.sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) -
          CATEGORY_ORDER.indexOf(b.category) ||
        a.name.localeCompare(b.name, 'en'),
    );
  }

  async get(id: string): Promise<StoryMine | undefined> {
    const [rows] = (await runQuery(
      this.person,
      `SELECT ${STORY_FIELDS} FROM type::record('story', $id)`,
      { id },
    )) as [RawStory[]];
    if (!rows.length) return undefined;
    return (await this.withTags(rows))[0];
  }

  /** Newest first (by creation, then id); `cursor` = the last row's position. */
  async list(
    status: string | undefined,
    limit: number,
    cursor: { createdAt: string; id: string } | undefined,
  ): Promise<{ data: StoryMine[]; next?: { createdAt: string; id: string } }> {
    const where = [
      'submitter = $auth',
      ...(status ? ['status = $status'] : []),
      ...(cursor
        ? [
            '(createdAt < <datetime> $c OR (createdAt = <datetime> $c AND id < <record> $cid))',
          ]
        : []),
    ].join(' AND ');
    const [rows] = (await runQuery(
      this.person,
      `SELECT ${STORY_FIELDS}, createdAt AS rawCreatedAt FROM story WHERE ${where}
         ORDER BY createdAt DESC, id DESC LIMIT $limit`,
      {
        status,
        c: cursor?.createdAt,
        cid: cursor ? `story:${cursor.id}` : undefined,
        limit: limit + 1,
      },
    )) as [(RawStory & { rawCreatedAt: string })[]];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: await this.withTags(page),
      next:
        rows.length > limit && last
          ? { createdAt: last.rawCreatedAt, id: recordKey(last.id) }
          : undefined,
    };
  }

  /** CreateDraftStory, once per Idempotency-Key (D29). */
  async create(
    input: CreateInput,
    idempotency: { scope: IdempotencyScope; requestHash: string },
  ): Promise<CommandResult> {
    try {
      const { response } = await runIdempotent(
        this.person,
        idempotency.scope,
        idempotency.requestHash,
        async () => {
          this.checkLimits(await this.settings(), input);
          await this.checkTags(input.tagSlugs);
          return {
            status: 201,
            statements: `LET $story = (CREATE ONLY type::record('story', rand::ulid()) CONTENT {
                submitter: $auth, slug: $slug, title: $title, description: $description,
                body: $body, bylineName: $bylineName, primaryFormat: $format,
                tagRefs: $tags.map(|$t| type::record('tag', $t))
              } RETURN id, version);
              IF $story = NONE { THROW 'story_cmd:not_written' };
              LET $result = { id: $story.id, version: $story.version };`,
            vars: {
              slug: slugFor(input.title, randomBytes(4).toString('hex')),
              title: input.title,
              description: input.description ?? '',
              body: input.body ?? undefined,
              bylineName: input.bylineName ?? undefined,
              format: input.primaryFormat,
              tags: input.tagSlugs ?? [],
            },
          };
        },
      );
      return { id: recordKey(response.id), version: response.version ?? 1 };
    } catch (err) {
      throw this.problem(err, 'create');
    }
  }

  /** EditStory: a JSON Merge Patch on the editable fields, at version `ifMatch`. */
  async edit(
    id: string,
    ifMatch: number,
    patch: StoryFields,
  ): Promise<CommandResult> {
    try {
      return await retryOnConflict(async () => {
        const current = await this.get(id);
        if (!current) throw new NotFoundException();
        if (current.version !== ifMatch) throw new StaleVersionException();
        if (!EDITABLE.includes(current.status)) throw this.locked();
        if (
          current.primaryFormat === 'written' &&
          'body' in patch &&
          !trimmedTextLength(patch.body ?? '')
        ) {
          textRequired();
        }
        // An edit over a maximum is refused only if it makes it worse, so a draft over a
        // newly lowered maximum can be trimmed (Joel, 2026-10-30); submitting needs them all.
        this.checkLimits(await this.settings(), patch, current);
        await this.checkTags(patch.tagSlugs);
        const sets: string[] = [];
        const vars: Record<string, unknown> = { id, version: ifMatch };
        for (const field of [
          'title',
          'description',
          'body',
          'bylineName',
        ] as const) {
          if (!(field in patch)) continue;
          const value = patch[field];
          sets.push(
            value === null ? `${field} = NONE` : `${field} = $${field}`,
          );
          if (value !== null) vars[field] = value;
        }
        if (patch.title !== undefined) {
          sets.push('slug = $slug');
          vars['slug'] = slugFor(patch.title, slugSuffix(current.slug));
        }
        if (patch.tagSlugs) {
          sets.push("tagRefs = $tags.map(|$t| type::record('tag', $t))");
          vars['tags'] = patch.tagSlugs;
        }
        // The image (M2 plan PR 10): removed, or its description changed. Its file stays at
        // Bunny for the clean-up sweep (an approved copy may still show it). Only RequestUpload
        // puts one on (D80); the database keeps the person to these two changes.
        if (patch.image === null) sets.push('image = NONE');
        else if (patch.image) {
          if (!current.image) {
            fail400('/image', 'this story has no picture to describe');
          }
          sets.push(patch.image.alt ? 'image.alt = $alt' : 'image.alt = NONE');
          if (patch.image.alt) vars['alt'] = patch.image.alt;
        }
        // An empty patch still makes a version step (nothing else to do; D29).
        if (!sets.length) sets.push('title = title');
        const results = await runQuery(
          this.person,
          `BEGIN TRANSACTION;
           LET $s = (SELECT version, status FROM type::record('story', $id))[0];
           IF $s = NONE { THROW 'story_cmd:not_found' };
           IF $s.version != $version { THROW 'story_cmd:stale_version' };
           IF $s.status NOT IN ['draft', 'changes_requested'] { THROW 'story_cmd:locked' };
           LET $u = (UPDATE ONLY type::record('story', $id) SET ${sets.join(', ')} RETURN id, version);
           IF $u = NONE { THROW 'story_cmd:not_written' };
           $u;
           COMMIT TRANSACTION;`,
          vars,
        );
        const row = requireWritten<{ id: string; version: number }>(
          results[results.length - 2],
          'story',
        );
        return { id: recordKey(row.id), version: row.version };
      });
    } catch (err) {
      throw this.problem(err, 'edit');
    }
  }

  /**
   * SubmitStory: draft/changes_requested → pending, once per Idempotency-Key, at `ifMatch`.
   * `checkMedia`: a video or audio story's file checks (uploads.ts), run with the others.
   */
  async submit(
    id: string,
    ifMatch: number,
    idempotency: { scope: IdempotencyScope; requestHash: string },
    checkMedia?: () => Promise<void>,
  ): Promise<CommandResult> {
    try {
      const { response } = await runIdempotent(
        this.person,
        idempotency.scope,
        idempotency.requestHash,
        async () => {
          const current = await this.get(id);
          if (!current) throw new NotFoundException();
          if (current.version !== ifMatch) throw new StaleVersionException();
          if (!EDITABLE.includes(current.status)) {
            throw new ConflictException({
              code: 'story_not_submittable',
              message:
                'Only a draft, or a story sent back for changes, can be submitted',
            });
          }
          const set = await this.settings();
          // Submitting needs every limit in force now, minimums and maximums, whatever the
          // limits were when the draft was started (Joel, 2026-10-30: no grandfathering).
          if (current.tags.length < set.tagsMin) {
            throw new BadRequestException({
              code: 'tags_required',
              message:
                set.tagsMin === 1
                  ? 'Choose at least one theme before submitting'
                  : `Choose at least ${set.tagsMin} themes before submitting`,
              errors: [
                {
                  pointer: '/tagSlugs',
                  message: `choose at least ${set.tagsMin}`,
                },
              ],
            });
          }
          if ([...(current.body ?? '')].length > set.storyTextMax) {
            throw this.tooLong(set.storyTextMax);
          }
          if (
            current.primaryFormat === 'written' &&
            trimmedTextLength(current.body) < set.storyTextMin
          ) {
            throw this.tooShort(set.storyTextMin);
          }
          if (current.tags.length > set.tagsMax) {
            throw this.tooManyTags(set.tagsMax);
          }
          if (!current.submittedAt) {
            const availableAt = await this.nextSubmissionAt();
            if (availableAt) throw this.weekly(availableAt);
          }
          await checkMedia?.();
          return {
            status: 200,
            statements: `LET $s = (SELECT version FROM type::record('story', $id))[0];
              IF $s = NONE { THROW 'story_cmd:not_found' };
              IF $s.version != $version { THROW 'story_cmd:stale_version' };
              LET $u = (UPDATE ONLY type::record('story', $id) SET status = 'pending'
                RETURN id, version);
              IF $u = NONE { THROW 'story_cmd:not_written' };
              LET $result = { id: $u.id, version: $u.version };`,
            vars: { id, version: ifMatch },
          };
        },
      );
      return { id: recordKey(response.id), version: response.version ?? 1 };
    } catch (err) {
      throw await this.submitProblem(err);
    }
  }

  /**
   * WithdrawStory at `ifMatch`: the story leaves review or the site (→ `withdrawn`), and its
   * `publicStory` row goes in the same transaction (D17, D51: gone on the next request). No
   * consent needed, and nothing in it changes.
   */
  async withdraw(id: string, ifMatch: number): Promise<CommandResult> {
    try {
      return await retryOnConflict(async () => {
        const results = await runQuery(
          this.person,
          `BEGIN TRANSACTION;
           LET $s = (SELECT version, status FROM type::record('story', $id))[0];
           IF $s = NONE { THROW 'story_cmd:not_found' };
           IF $s.version != $version { THROW 'story_cmd:stale_version' };
           IF $s.status NOT IN $withdrawable { THROW 'story_cmd:not_withdrawable' };
           LET $u = (UPDATE ONLY type::record('story', $id) SET status = 'withdrawn' RETURN id, version);
           IF $u = NONE { THROW 'story_cmd:not_written' };
           DELETE type::record('publicStory', $id);
           $u;
           COMMIT TRANSACTION;`,
          { id, version: ifMatch, withdrawable: WITHDRAWABLE },
        );
        const row = requireWritten<{ id: string; version: number }>(
          results[results.length - 2],
          'story',
        );
        return { id: recordKey(row.id), version: row.version };
      });
    } catch (err) {
      throw this.lifecycleProblem(err);
    }
  }

  /**
   * DeleteStory at `ifMatch` (D71): the person's own draft, withdrawn, rejected or
   * changes-requested story, gone with its read-model rows, reviews and others' hearts
   * (story_erasure_cascade). Answers the Bunny videos api-user made for it (its upload grants,
   * D80), for the caller to delete at Bunny once this has committed. The grants themselves stay: the upload limits count them
   * for 7 days (D113).
   */
  async delete(id: string, ifMatch: number): Promise<{ videos: string[] }> {
    try {
      return await retryOnConflict(async () => {
        const results = await runQuery(
          this.person,
          `BEGIN TRANSACTION;
           LET $s = (SELECT version, status FROM type::record('story', $id))[0];
           IF $s = NONE { THROW 'story_cmd:not_found' };
           IF $s.version != $version { THROW 'story_cmd:stale_version' };
           IF $s.status NOT IN $deletable { THROW 'story_cmd:not_deletable' };
           LET $videos = (SELECT VALUE record::id(id) FROM uploadGrant
             WHERE story = type::record('story', $id));
           LET $gone = (DELETE type::record('story', $id) RETURN BEFORE);
           IF array::len($gone) = 0 { THROW 'story_cmd:not_deletable' };
           $videos;
           COMMIT TRANSACTION;`,
          { id, version: ifMatch, deletable: DELETABLE },
        );
        return { videos: (results[results.length - 2] ?? []) as string[] };
      });
    } catch (err) {
      throw this.lifecycleProblem(err);
    }
  }

  /** The settings in force (W3), read in the person's session (everyone reads them). */
  async settings(): Promise<SubmissionSettings> {
    const [set] = (await runQuery(this.person, SUBMISSION_SETTINGS_SQL)) as [
      SubmissionSettings,
    ];
    return set;
  }

  /** What the submit page shows: the settings' text and theme limits, and the person's own. */
  async limits(): Promise<SubmissionLimits> {
    const results = (await runQuery(
      this.person,
      `RETURN fn::settings::submission();
       RETURN fn::limits::effective($auth);
       RETURN count(SELECT id FROM story WHERE submitter = $auth AND status = 'draft');
       RETURN fn::story::next_submission_at($auth);
       RETURN fn::upload::next_allowed_at($auth, 'video');`,
    )) as [
      SubmissionSettings,
      {
        openDraftsMax?: number | null;
        submissionsPer7Days?: number | null;
        uploadRequestsPerHour: number;
        uploadsPer7Days?: number | null;
        videoMaxBytes: number;
        audioMaxBytes: number;
        mediaMaxSeconds: number;
      },
      number,
      string | null | undefined,
      string | null | undefined,
    ];
    const [set, mine, open, next, nextUpload] = results;
    return {
      storyText: { min: set.storyTextMin, max: set.storyTextMax },
      tags: { min: set.tagsMin, max: set.tagsMax },
      openDrafts: { max: mine.openDraftsMax ?? null, open },
      submissions: {
        per7Days: mine.submissionsPer7Days ?? null,
        nextAvailableAt: next ? new Date(next).toISOString() : null,
      },
      uploads: {
        videoMaxBytes: mine.videoMaxBytes,
        audioMaxBytes: mine.audioMaxBytes,
        maxDurationSeconds: mine.mediaMaxSeconds,
        perHour: mine.uploadRequestsPerHour,
        per7Days: mine.uploadsPer7Days ?? null,
        nextAvailableAt: nextUpload ? new Date(nextUpload).toISOString() : null,
      },
    };
  }

  /** The settings' maximums on what a command writes (W3); the database checks them too. */
  private checkLimits(
    set: SubmissionSettings,
    f: StoryFields,
    current?: { body: string | null; tags: unknown[] },
  ) {
    const errors: { pointer: string; message: string }[] = [];
    const was = {
      body: [...(current?.body ?? '')].length,
      tags: current?.tags.length ?? 0,
    };
    if (typeof f.body === 'string') {
      const len = [...f.body].length;
      if (len > set.storyTextMax && len > was.body) {
        errors.push({
          pointer: '/body',
          message: `at most ${set.storyTextMax} characters`,
        });
      }
    }
    if (f.tagSlugs) {
      const n = f.tagSlugs.length;
      if (n > set.tagsMax && n > was.tags) {
        errors.push({
          pointer: '/tagSlugs',
          message: `at most ${set.tagsMax} themes`,
        });
      }
    }
    if (errors.length) overLimit(errors);
  }

  private async nextSubmissionAt(): Promise<string | undefined> {
    const [at] = (await runQuery(
      this.person,
      'RETURN fn::story::next_submission_at($auth)',
    )) as [string | null | undefined];
    return at ? new Date(at).toISOString() : undefined;
  }

  private async checkTags(slugs: string[] | undefined) {
    if (!slugs?.length) return;
    const [found] = (await runQuery(
      this.person,
      `SELECT VALUE id FROM $tags.map(|$t| type::record('tag', $t)) WHERE id != NONE`,
      { tags: slugs },
    )) as [unknown[]];
    if (found.length !== slugs.length) unknownTags();
  }

  /** Tag rows for the stories' tagRefs, in each story's order. */
  private async withTags(rows: RawStory[]): Promise<StoryMine[]> {
    const refs = [...new Set(rows.flatMap((r) => r.tagRefs))];
    const [tags] = refs.length
      ? ((await runQuery(
          this.person,
          `SELECT <string> id AS ref, record::id(id) AS slug, name, category, version
             FROM $refs.map(|$r| <record> $r)`,
          { refs },
        )) as [(Tag & { ref: string })[]])
      : [[] as (Tag & { ref: string })[]];
    const byRef = new Map(
      tags.map(({ ref, ...tag }) => [ref, tag satisfies Tag]),
    );
    return rows.map((r) => ({
      id: recordKey(r.id),
      version: r.version,
      slug: r.slug,
      status: r.status,
      title: r.title,
      description: r.description,
      body: r.body ?? null,
      bylineName: r.bylineName ?? null,
      primaryFormat: r.primaryFormat,
      media: (r.media ?? []).map((m) => ({
        format: m.format,
        playbackUrl: null,
        thumbnailUrl: null,
        width: m.width ?? null,
        height: m.height ?? null,
        durationSeconds: m.durationSeconds ?? null,
        processing: m.processing ?? null,
      })),
      image: r.image
        ? {
            url: this.urls?.imageUrl(r.image.path) ?? null,
            width: r.image.width,
            height: r.image.height,
            alt: r.image.alt ?? null,
          }
        : null,
      tags: r.tagRefs.flatMap((ref) => byRef.get(ref) ?? []),
      rejectionFeedback: r.rejectionFeedback ?? null,
      submittedAt: iso(r.submittedAt),
      approvedAt: iso(r.approvedAt),
      createdAt: iso(r.createdAt) as string,
      updatedAt: iso(r.updatedAt) as string,
      draftExpiresAt: iso(r.draftExpiresAt),
    }));
  }

  private locked() {
    return new ConflictException({
      code: 'story_locked',
      message: 'A story can’t be changed once it’s submitted',
    });
  }

  /** Over the text maximum in force at submit: a clear 400 that says the limit (Joel, 2026-10-30). */
  private tooLong(max: number) {
    return new BadRequestException({
      code: 'story_text_too_long',
      message: `Your story is longer than the current limit of ${max} characters. Shorten it, then submit.`,
      limit: max,
      errors: [{ pointer: '/body', message: `at most ${max} characters` }],
    });
  }

  /** Over the theme maximum in force at submit (Joel, 2026-10-30). */
  private tooManyTags(max: number) {
    return new BadRequestException({
      code: 'too_many_tags',
      message: `Your story has more themes than the current limit of ${max}. Remove some, then submit.`,
      limit: max,
      errors: [{ pointer: '/tagSlugs', message: `at most ${max} themes` }],
    });
  }

  private tooShort(min: number) {
    return new BadRequestException({
      code: 'story_text_too_short',
      message: `A written story needs at least ${min} characters to be submitted`,
      errors: [{ pointer: '/body', message: `at least ${min} characters` }],
    });
  }

  private weekly(availableAt: string) {
    return new ConflictException({
      code: 'weekly_submission_limit_reached',
      message:
        'You’ve submitted as many stories for review as you can for now. Your draft is saved, so you can submit it later.',
      availableAt,
    });
  }

  /** The database's refusals (the API's checks can lose a race) as problems. */
  private problem(err: unknown, command: 'create' | 'edit'): unknown {
    if (err instanceof HttpException) return err;
    const over = storyLimitOf(err);
    if (over) {
      // The settings changed between the API's check and the write.
      return new BadRequestException({
        code: 'validation_failed',
        message: 'The story is over the limits',
        errors: [
          over === 'text'
            ? { pointer: '/body', message: 'longer than allowed' }
            : { pointer: '/tagSlugs', message: 'more themes than allowed' },
        ],
      });
    }
    if (submissionLimitOf(err) === 'open_drafts') {
      return new ConflictException({
        code: 'draft_limit_reached',
        message:
          'You already have as many drafts open as you can. Continue one of them, or submit one first.',
      });
    }
    const code =
      err instanceof DatabaseQueryError
        ? ERR.exec(err.message)?.[1]
        : undefined;
    if (code === 'not_found') return new NotFoundException();
    if (code === 'stale_version') return new StaleVersionException();
    if (code === 'locked' || /content is locked/.test(String(err)))
      return this.locked();
    if (
      code === 'not_written' ||
      /needs the submitter’s current Art 9/.test(String(err))
    ) {
      // Refused by the story permissions or consent events: consent changed meanwhile.
      return new ForbiddenException({
        code: 'consent_required',
        message:
          command === 'create'
            ? 'Starting a story needs your consent on the forms in force'
            : 'Changing a story needs your current consent',
      });
    }
    return err;
  }

  /** WithdrawStory's and DeleteStory's refusals as problems. */
  private lifecycleProblem(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const code =
      err instanceof DatabaseQueryError
        ? ERR.exec(err.message)?.[1]
        : undefined;
    if (code === 'not_found') return new NotFoundException();
    if (code === 'stale_version') return new StaleVersionException();
    if (code === 'not_withdrawable' || code === 'not_written') {
      return new ConflictException({
        code: 'story_not_withdrawable',
        message:
          'Only a story waiting for review, in review or published can be withdrawn',
      });
    }
    if (code === 'not_deletable') {
      return new ConflictException({
        code: 'story_not_deletable',
        message:
          'Only a draft, or a story sent back for changes, withdrawn or not accepted, can be deleted. Withdraw it first.',
      });
    }
    return err;
  }

  private async submitProblem(err: unknown): Promise<unknown> {
    if (err instanceof HttpException) return err;
    if (submissionLimitOf(err) === 'weekly_submission') {
      const at = await this.nextSubmissionAt().catch(() => undefined);
      return this.weekly(at ?? new Date(Date.now() + 7 * 864e5).toISOString());
    }
    if (isStoryTextTooShortError(err)) {
      const set = await this.settings().catch(() => undefined);
      return this.tooShort(set?.storyTextMin ?? 0);
    }
    const over = storyLimitOf(err);
    if (over) {
      // The settings changed between the API's check and the submit.
      const set = await this.settings().catch(() => undefined);
      return over === 'text'
        ? this.tooLong(set?.storyTextMax ?? 0)
        : this.tooManyTags(set?.tagsMax ?? 0);
    }
    const code =
      err instanceof DatabaseQueryError
        ? ERR.exec(err.message)?.[1]
        : undefined;
    if (code === 'not_found') return new NotFoundException();
    if (code === 'stale_version') return new StaleVersionException();
    if (
      code === 'not_written' ||
      /submitting a story needs/.test(String(err))
    ) {
      return new ForbiddenException({
        code: 'consent_required',
        message: 'Submitting needs your current consent on the forms in force',
      });
    }
    if (/status change not allowed/.test(String(err))) {
      return new ConflictException({
        code: 'story_not_submittable',
        message:
          'Only a draft, or a story sent back for changes, can be submitted',
      });
    }
    return err;
  }
}
