import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import { runQuery, SURREAL } from '@heisreal/database';
import {
  ifNoneMatches,
  isStoryId,
  ProblemException,
  recordKey,
  weakETag,
} from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import { MediaUrls } from '@heisreal/story-cards';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';
import { isCursorTime } from '../cursor-time';
import {
  type Decision,
  decide,
  parseAnyway,
  parseNote,
  parseReviewTag,
  requireAdminForAnyway,
  reviewTag,
} from './decisions';

/** Moderators' links last one hour (M3 plan concern C6), counted from each answer. */
export const MODERATION_LINK_SECONDS = 60 * 60;

/**
 * The moderators' list (MD-3, MD-4: Joel 2026-11-14): every story that is not public, one state
 * at a time. Moderators see waiting for review (`pending`), being edited (`editing` after it was
 * sent: sent back, or its owner pressed Edit), taken down (`hidden`, by a moderator or by the
 * site) and rejected; Admins also see drafts never sent (`draft`: `editing` with no status entry),
 * "visibility of users who might be preparing spam or other malicious activities".
 */
const LIST_STATES = [
  'pending',
  'editing',
  'hidden',
  'rejected',
  'draft',
] as const;
type ListState = (typeof LIST_STATES)[number];

/** A theme id, as browse takes it (api-public-read's `?theme=`). */
const THEME_ID = /^[0-9A-Za-z_]{1,40}$/;

/** What each row shows of the story: no words beyond the title, no files, no submitter. */
const LIST_FIELDS = (
  s: string,
) => `${s}.title AS title, ${s}.primaryFormat AS primaryFormat,
    ${s}.updatedAt AS updatedAt,
    ${s}.themeRefs.map(|$t| { id: record::id($t), name: $t.name }) AS themes`;

/**
 * A logged state: the status entries the story points at (its current state), oldest first, on
 * the status log's (status, at) index (storyStatusLog_queue): for `pending` the same order as the
 * old queue. An old entry of a story that has moved on is skipped. Bind `$state`, `$theme` (or
 * NONE), `$after` = [at, entry id] or NONE, `$take`.
 */
const LIST_LOGGED_SQL = `
  LET $c = IF $after != NONE { <datetime> $after[0] };
  LET $cid = IF $after != NONE { type::record('storyStatusLog', $after[1]) };
  SELECT record::id(id) AS key, record::id(story) AS id, action, at AS since,
    ${LIST_FIELDS('story')},
    array::max(SELECT VALUE at FROM storyStatusLog WHERE story = $parent.story AND action = 'sent')
      AS sentAt
  FROM storyStatusLog WITH INDEX storyStatusLog_queue
  WHERE status = $state AND story.currentStatus = id
    AND ($theme = NONE OR $theme IN story.themeIds)
    AND ($c = NONE OR at > $c OR (at = $c AND id > $cid))
  ORDER BY since ASC, key ASC LIMIT $take;`;

/** Drafts never sent (Admins only): no status entry; oldest started first. */
const LIST_DRAFTS_SQL = `
  LET $c = IF $after != NONE { <datetime> $after[0] };
  LET $cid = IF $after != NONE { type::record('story', $after[1]) };
  SELECT record::id(id) AS key, record::id(id) AS id, createdAt AS since, ${LIST_FIELDS('$this')}
  FROM story
  WHERE currentStatus = NONE
    AND ($theme = NONE OR $theme IN themeIds)
    AND ($c = NONE OR createdAt > $c OR (createdAt = $c AND id > $cid))
  ORDER BY since ASC, key ASC LIMIT $take;`;

/**
 * One story under review (task 3.2): what the public would see, its files' processing state, and
 * its status log with moderators' notes, never who wrote an entry (`by`) or anything about the
 * person beyond their byline.
 */
const STORY_SQL = `
  LET $s = type::record('story', $id);
  SELECT record::id(id) AS id, version, fn::story::status_of($this) AS status, title,
    description, body, bylineName, primaryFormat,
    IF currentStatus != NONE { record::id(currentStatus) } AS entry,
    IF mediaFile != NONE { record::id(mediaFile) } AS mediaKey,
    IF image != NONE { record::id(image.file) } AS imageKey,
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
  SELECT id, action, status, actor, comment, at,
    IF at > fn::story::sender_ips_expire_before() { senderIp } AS senderIp
  FROM storyStatusLog WITH INDEX storyStatusLog_story
    WHERE story = $s ORDER BY at ASC, id ASC;`;

type Opt<T> = T | null | undefined;

interface ListRow {
  key: string;
  id: string;
  action?: Opt<string>;
  since: string;
  sentAt?: Opt<string>;
  updatedAt: string;
  title: string;
  primaryFormat: string;
  themes: { id: string; name?: Opt<string> }[];
}

interface StoryRow {
  id: string;
  version: number;
  status: string;
  entry?: Opt<string>;
  mediaKey?: Opt<string>;
  imageKey?: Opt<string>;
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
  /** The sent entry's sender IP address, if it is under 30 days old (block list). */
  senderIp?: Opt<string>;
}

const or = <T>(v: Opt<T>): T | null => v ?? null;
const iso = (d: string) => new Date(d).toISOString();
const isoOr = (d: Opt<string>) => (d ? iso(d) : null);

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
function encodeCursor(row: ListRow): string {
  return Buffer.from(JSON.stringify([row.since, recordKey(row.key)])).toString(
    'base64url',
  );
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

/** MD-3: drafts never sent are for Admins only. */
function requireAdmin(role?: string): void {
  if (role !== 'Admin') {
    throw new ForbiddenException({
      code: 'role_required',
      message: 'Only an Admin can see drafts never sent',
      requiredRole: 'Admin',
    });
  }
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
 * api-admin.yaml, tag Moderation (M3 plan PRs 1 and 6; MD-3, MD-4): the moderators' list, one
 * story, and the decisions on it: approve, send back, reject (from pending), hide (from approved) and show again
 * (from hidden). Moderator and above on all: the database knows moderators only as api-admin's
 * login (M3 plan concern C2), so this role check is the one gate, and the integration tests refuse
 * a User on each route. "Approve anyway" and drafts never sent are Admin only (G24, MD-3).
 */
@Controller('v1/moderation')
export class ModerationController {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(MediaUrls) private readonly links: MediaUrls,
    private readonly people: PersonSessions,
  ) {}

  /**
   * One decision (decisions.ts): checked against what the moderator reviewed (`If-Match`, G14 B),
   * written as the moderator (their own user record, `by`), answering the story's version and, in
   * `ETag`, what the next decision names.
   */
  private async decision(
    req: Request,
    res: Response,
    id: string,
    ifMatch: string | undefined,
    action: Decision,
    { comment, anyway = false }: { comment?: string; anyway?: boolean } = {},
  ) {
    if (!isStoryId(id)) throw new NotFoundException();
    const reviewed = parseReviewTag(ifMatch);
    if (reviewed === undefined) {
      throw new ProblemException(
        HttpStatus.PRECONDITION_REQUIRED,
        'if_match_required',
        'Precondition required',
        'This command needs If-Match with the story’s reviewTag.',
      );
    }
    if (reviewed === 'invalid') {
      throw new ProblemException(
        HttpStatus.PRECONDITION_FAILED,
        'stale_version',
        'Precondition failed',
        'This story changed since you opened it',
      );
    }
    const { role } = await this.people.authenticate(req);
    requireAdminForAnyway(anyway, role);
    // Who decides: the moderator's own user record, from their own database session (D27).
    const by = await this.people.run(req, async ({ user }) => user);
    const done = await decide(this.db, {
      id,
      reviewed,
      action,
      by,
      comment,
      anyway,
    });
    res.setHeader('ETag', `"${done.tag}"`);
    return { id, version: done.version };
  }

  @Post('stories/:id/approve')
  @HttpCode(200)
  @RequiresRole('Moderator')
  approveStory(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const anyway = parseAnyway(body);
    return this.decision(req, res, id, ifMatch, 'approved', { anyway });
  }

  @Post('stories/:id/request-changes')
  @HttpCode(200)
  @RequiresRole('Moderator')
  requestStoryChanges(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const comment = parseNote(body, 'feedbackToSubmitter');
    return this.decision(req, res, id, ifMatch, 'changesRequested', {
      comment,
    });
  }

  @Post('stories/:id/reject')
  @HttpCode(200)
  @RequiresRole('Moderator')
  rejectStory(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const comment = parseNote(body, 'feedbackToSubmitter');
    return this.decision(req, res, id, ifMatch, 'rejected', { comment });
  }

  @Post('stories/:id/hide')
  @HttpCode(200)
  @RequiresRole('Moderator')
  hideStory(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const comment = parseNote(body, 'reason');
    return this.decision(req, res, id, ifMatch, 'hiddenByModerator', {
      comment,
    });
  }

  @Post('stories/:id/show')
  @HttpCode(200)
  @RequiresRole('Moderator')
  showStory(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const anyway = parseAnyway(body);
    return this.decision(req, res, id, ifMatch, 'shownByModerator', {
      anyway,
    });
  }

  @Get('stories')
  @RequiresRole('Moderator')
  async listModerationStories(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Query('state') stateRaw?: string,
    @Query('theme') themeRaw?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const state = (stateRaw ?? 'pending') as ListState;
    if (!LIST_STATES.includes(state)) {
      throw invalid('/state', `state is one of ${LIST_STATES.join(', ')}`);
    }
    const theme =
      themeRaw === undefined || themeRaw === '' ? undefined : themeRaw;
    if (theme !== undefined && !THEME_ID.test(theme)) {
      throw invalid('/theme', 'A theme id: letters, digits and underscores.');
    }
    const take = parseLimit(limit);
    const after = decodeCursor(cursor);
    if (state === 'draft') {
      // MD-3: drafts never sent are for Admins only.
      const { role } = await this.people.authenticate(req);
      requireAdmin(role);
    }
    const results = await runQuery(
      this.db,
      state === 'draft' ? LIST_DRAFTS_SQL : LIST_LOGGED_SQL,
      { state, theme, after, take: take + 1 },
    );
    const rows = (results.at(-1) ?? []) as ListRow[];
    const page = rows.slice(0, take);
    const last = page.at(-1);
    return conditional(
      res,
      {
        data: page.map((r) => ({
          id: recordKey(r.id),
          state,
          action: or(r.action),
          title: r.title,
          primaryFormat: r.primaryFormat,
          themes: r.themes.flatMap((t) =>
            t.name ? [{ id: t.id, name: t.name }] : [],
          ),
          since: iso(r.since),
          sentAt: isoOr(r.sentAt),
          updatedAt: iso(r.updatedAt),
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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    if (!isStoryId(id)) throw new NotFoundException();
    const results = await runQuery(this.db, STORY_SQL, { id });
    const [rows, log] = results.slice(-2) as [StoryRow[], EntryRow[]];
    const s = rows[0];
    if (!s) throw new NotFoundException();
    const { role } = await this.people.authenticate(req);
    // MD-3: a draft never sent (no status entry) opens for Admins only; to a Moderator it isn't
    // there, as it isn't on their list.
    if (!s.entry && role !== 'Admin') throw new NotFoundException();
    const sent = log.filter((e) => e.action === 'sent').at(-1);
    // Block list (G21 D, G24): the address it was sent from, for an Admin to copy into the block
    // list; Moderators never see it. Kept 30 days (then housekeeping clears it).
    const senderIp = role === 'Admin' && sent ? or(sent.senderIp) : null;
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
        submittedAt: sent ? iso(sent.at) : null,
        senderIp,
        reviewTag: reviewTag({
          entry: s.entry ?? '',
          media: or(s.mediaKey),
          image: or(s.imageKey),
        }),
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
