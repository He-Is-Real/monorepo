import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import { ifNoneMatches, isStoryId, recordKey, weakETag } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import { MediaUrls } from '@heisreal/story-cards';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { isCursorTime } from '../cursor-time';

/** Moderators' links last one hour (M3 plan concern C6), counted from each answer. */
export const MODERATION_LINK_SECONDS = 60 * 60;

/**
 * The state a story under moderation has (Story states, Joel 2026-11-11: moderators decide
 * straight from pending, no pick-up); any other is not found here.
 */
const UNDER_MODERATION = ['pending'];

/**
 * The queue (task 3.1): stories whose current status entry is `pending`, oldest sent first, on
 * the status log's (status, at) index (storyStatusLog_queue). Bind `$after` = [at, entry id] or
 * NONE, `$take`. An old pending entry of a story that has moved on is skipped: only the entry
 * the story points at counts.
 */
const QUEUE_SQL = `
  LET $c = IF $after != NONE { <datetime> $after[0] };
  LET $cid = IF $after != NONE { type::record('storyStatusLog', $after[1]) };
  SELECT record::id(id) AS entry, record::id(story) AS id, story.version AS version, status,
    story.title AS title, story.primaryFormat AS primaryFormat, at AS submittedAt
  FROM storyStatusLog WITH INDEX storyStatusLog_queue
  WHERE status = 'pending' AND story.currentStatus = id
    AND ($c = NONE OR at > $c OR (at = $c AND id > $cid))
  ORDER BY submittedAt ASC, entry ASC LIMIT $take;`;

/**
 * One story under review (task 3.2): what the public would see, its files' processing state, and
 * its status log with moderators' notes, never who wrote an entry (`by`) or anything about the
 * person beyond their byline.
 */
const STORY_SQL = `
  LET $s = type::record('story', $id);
  SELECT record::id(id) AS id, version, fn::story::status_of($this) AS status, title,
    description, body, bylineName, primaryFormat,
    themeRefs.map(|$t| { id: record::id($t), name: $t.name }) AS themes,
    IF mediaFile != NONE {
      [object::extend(mediaFile.{ format, thumbnailPath, width, height, processing },
        { videoId: record::id(mediaFile), durationSeconds: mediaFile.lengthSeconds })]
    } ELSE { [] } AS media,
    IF image != NONE {
      object::extend(image.file.{ width, height, processing },
        { path: record::id(image.file), alt: image.alt })
    } AS image
  FROM $s;
  SELECT id, action, status, actor, comment, at FROM storyStatusLog WITH INDEX storyStatusLog_story
    WHERE story = $s ORDER BY at ASC, id ASC;`;

type Opt<T> = T | null | undefined;

interface QueueRow {
  entry: string;
  id: string;
  version: number;
  status: string;
  title: string;
  primaryFormat: string;
  submittedAt: string;
}

interface StoryRow {
  id: string;
  version: number;
  status: string;
  title: string;
  description: string;
  body?: Opt<string>;
  bylineName?: Opt<string>;
  primaryFormat: string;
  themes: { id: string; name?: Opt<string> }[];
  media: {
    format: 'video' | 'audio';
    videoId: string;
    thumbnailPath?: Opt<string>;
    width?: Opt<number>;
    height?: Opt<number>;
    durationSeconds?: Opt<number>;
    processing?: Opt<string>;
  }[];
  image?: Opt<{
    path: string;
    width: number;
    height: number;
    alt?: Opt<string>;
    processing?: Opt<string>;
  }>;
}

interface EntryRow {
  action: string;
  status: string;
  actor: string;
  comment?: Opt<string>;
  at: string;
}

const or = <T>(v: Opt<T>): T | null => v ?? null;
const iso = (d: string) => new Date(d).toISOString();

const invalid = (pointer: string, message: string) =>
  new BadRequestException({
    code: 'validation_failed',
    message,
    errors: [{ pointer, message }],
  });

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw invalid('/limit', 'limit is 1–50');
  }
  return n;
}

/** The entry's time as the database gave it (to the nanosecond), so no row repeats or is skipped. */
function encodeCursor(row: QueueRow): string {
  return Buffer.from(
    JSON.stringify([row.submittedAt, recordKey(row.entry)]),
  ).toString('base64url');
}

function decodeCursor(raw: string | undefined): [string, string] | undefined {
  if (raw === undefined) return undefined;
  try {
    const [at, entry] = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown[];
    if (
      typeof at === 'string' &&
      isCursorTime(at) &&
      typeof entry === 'string' &&
      isStoryId(entry)
    ) {
      return [at, entry];
    }
  } catch {
    // fall through
  }
  throw invalid('/cursor', 'The cursor isn’t one this service gave out');
}

/** `ETag` and `Cache-Control` for a query; `undefined` (and `304`) if the client has it. */
function conditional<T>(
  res: Response,
  body: T,
  ifNoneMatch: string | undefined,
): T | undefined {
  const etag = weakETag(body);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', etag);
  if (ifNoneMatches(ifNoneMatch, etag)) {
    res.status(HttpStatus.NOT_MODIFIED);
    return undefined;
  }
  return body;
}

/**
 * api-admin.yaml, tag Moderation, the read side (M3 plan PR 1; tasks 3.1 and 3.2): the queue and
 * one story under review, read-only. Moderator and above on both: the database knows moderators
 * only as api-admin's login (M3 plan concern C2), so this role check is the one gate, and the
 * integration tests refuse a User on each route. Nothing here writes yet; deciding comes in a
 * later PR.
 */
@Controller('v1/moderation')
export class ModerationController {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(MediaUrls) private readonly links: MediaUrls,
  ) {}

  @Get('queue')
  @RequiresRole('Moderator')
  async getModerationQueue(
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const take = parseLimit(limit);
    const results = await runQuery(this.db, QUEUE_SQL, {
      after: decodeCursor(cursor),
      take: take + 1,
    });
    const rows = (results.at(-1) ?? []) as QueueRow[];
    const page = rows.slice(0, take);
    const last = page.at(-1);
    return conditional(
      res,
      {
        data: page.map((r) => ({
          id: recordKey(r.id),
          version: r.version,
          status: r.status,
          title: r.title,
          primaryFormat: r.primaryFormat,
          submittedAt: iso(r.submittedAt),
        })),
        nextCursor: rows.length > take && last ? encodeCursor(last) : null,
      },
      ifNoneMatch,
    );
  }

  @Get('stories/:id')
  @RequiresRole('Moderator')
  async getModerationStory(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    if (!isStoryId(id)) throw new NotFoundException();
    const results = await runQuery(this.db, STORY_SQL, { id });
    const [rows, log] = results.slice(-2) as [StoryRow[], EntryRow[]];
    const s = rows[0];
    if (!s || !UNDER_MODERATION.includes(s.status)) {
      throw new NotFoundException();
    }
    const sent = log.filter((e) => e.action === 'sent').at(-1);
    if (!sent) throw new NotFoundException(); // never: pending follows a send
    const urls = this.links.expiringIn(MODERATION_LINK_SECONDS);
    return conditional(
      res,
      {
        id: recordKey(s.id),
        version: s.version,
        status: s.status,
        title: s.title,
        description: s.description,
        body: or(s.body),
        bylineName: or(s.bylineName),
        primaryFormat: s.primaryFormat,
        media: s.media.map((m) => {
          // Signed only once Bunny has processed it: before that there is nothing to play.
          const ready = m.processing === 'ready';
          return {
            format: m.format,
            playbackUrl: ready ? urls.playbackUrl(m.videoId) : null,
            thumbnailUrl: ready
              ? urls.thumbnailUrl(m.videoId, m.thumbnailPath)
              : null,
            width: or(m.width),
            height: or(m.height),
            captionsUrl: null,
            durationSeconds: or(m.durationSeconds),
            processing: or(m.processing),
          };
        }),
        image: s.image
          ? {
              url: urls.imageUrl(s.image.path),
              width: s.image.width,
              height: s.image.height,
              alt: or(s.image.alt),
              processing: or(s.image.processing),
            }
          : null,
        themes: s.themes.flatMap((t) =>
          t.name ? [{ id: t.id, name: t.name }] : [],
        ),
        submittedAt: iso(sent.at),
        statusLog: log.map((e) => ({
          action: e.action,
          status: e.status,
          actor: e.actor,
          comment: or(e.comment),
          at: iso(e.at),
        })),
      },
      ifNoneMatch,
    );
  }
}

@Module({ controllers: [ModerationController] })
export class ModerationModule {}
