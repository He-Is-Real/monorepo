import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { OWNER_FILE_FIELDS, runQuery, SURREAL } from '@heisreal/database';
import { isStoryId, recordKey } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';

/** The status as the status log records it (R6): none yet = draft; `hidden` shown as it is. */
const STATUS = `currentStatus.status ?? 'draft'`;

const SUMMARY = `record::id(id) AS id, slug, title, ${STATUS} AS status, primaryFormat,
  record::id(submitter) AS submitter, createdAt, updatedAt, version`;

const LIST_SQL = `
  LET $c = IF $after != NONE { <datetime> $after[0] };
  LET $cid = IF $after != NONE { type::record('story', $after[1]) };
  SELECT ${SUMMARY} FROM story
  WHERE $c = NONE OR createdAt < $c OR (createdAt = $c AND id < $cid)
  ORDER BY createdAt DESC, id DESC LIMIT $take;`;

const ONE_SQL = `
  LET $s = type::record('story', $id);
  SELECT ${SUMMARY}, description, body, bylineName,
    themeRefs.map(|$t| { id: record::id($t), name: $t.name }) AS themes, ${OWNER_FILE_FIELDS},
    IF socialMediaSharingConsent != NONE { record::id(socialMediaSharingConsent) } AS sharingVersion,
    socialMediaSharingConsentAgreedAt AS sharingAt
  FROM $s;
  SELECT record::id(id) AS id, status, actor, IF by != NONE { record::id(by) } AS by, comment,
    storyVersion, at, publishedAt, hiddenReason
  FROM storyStatusLog WHERE story = $s ORDER BY at ASC, id ASC;`;

type Opt<T> = T | null | undefined;

interface SummaryRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  primaryFormat: string;
  submitter: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface DetailRow extends SummaryRow {
  description: string;
  body?: Opt<string>;
  bylineName?: Opt<string>;
  themes: { id: string; name?: Opt<string> }[];
  media?: Opt<
    {
      format: 'video' | 'audio';
      bunnyVideoId?: Opt<string>;
      thumbnailPath?: Opt<string>;
      width?: Opt<number>;
      height?: Opt<number>;
      durationSeconds?: Opt<number>;
      processing?: Opt<string>;
    }[]
  >;
  image?: Opt<{
    path: string;
    width: number;
    height: number;
    alt?: Opt<string>;
    processing?: Opt<string>;
  }>;
  sharingVersion?: Opt<number>;
  sharingAt?: Opt<string>;
}

interface EntryRow {
  id: string;
  status: string;
  actor: string;
  by?: Opt<string>;
  comment?: Opt<string>;
  storyVersion: number;
  at: string;
  publishedAt?: Opt<string>;
  hiddenReason?: Opt<string>;
}

const or = <T>(v: Opt<T>): T | null => v ?? null;
const iso = (d: Opt<string>) => (d ? new Date(d).toISOString() : null);

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

function encodeCursor(row: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.id])).toString(
    'base64url',
  );
}

function decodeCursor(raw: string | undefined): [string, string] | undefined {
  if (raw === undefined) return undefined;
  try {
    const [createdAt, id] = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown[];
    if (
      typeof createdAt === 'string' &&
      !Number.isNaN(Date.parse(createdAt)) &&
      typeof id === 'string' &&
      isStoryId(id)
    ) {
      return [createdAt, id];
    }
  } catch {
    // fall through
  }
  throw invalid('/cursor', 'The cursor isn’t one this service gave out');
}

function toSummary(r: SummaryRow) {
  return {
    id: recordKey(r.id),
    slug: r.slug,
    title: r.title,
    status: r.status,
    primaryFormat: r.primaryFormat,
    submitter: recordKey(r.submitter),
    createdAt: iso(r.createdAt) as string,
    updatedAt: iso(r.updatedAt) as string,
    version: r.version,
  };
}

/**
 * api-admin.yaml, tag AllStories (R15, Joel 2026-11-05): super admins see every story in every
 * status, drafts included, with its status log (R6) and files, read-only. api-admin's login
 * reads every story (docs/db-permissions.md); the SuperAdmin role is checked here (D1), as every
 * api-admin route's role is. Moderators and admins see stories from `pending` on, through
 * moderation, never here. No route here writes.
 */
@Controller('v1/admin/stories')
export class AllStoriesController {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  @Get()
  @RequiresRole('SuperAdmin')
  async listAllStories(
    @Res({ passthrough: true }) res: Response,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const take = parseLimit(limit);
    const results = await runQuery(this.db, LIST_SQL, {
      after: decodeCursor(cursor),
      take: take + 1,
    });
    const rows = (results.at(-1) ?? []) as (SummaryRow & {
      createdAt: string;
    })[];
    const page = rows.slice(0, take);
    const last = page.at(-1);
    res.setHeader('Cache-Control', 'private, no-store');
    return {
      data: page.map(toSummary),
      nextCursor:
        rows.length > take && last
          ? encodeCursor({ createdAt: last.createdAt, id: recordKey(last.id) })
          : null,
    };
  }

  @Get(':id')
  @RequiresRole('SuperAdmin')
  async getAnyStory(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isStoryId(id)) throw new NotFoundException();
    const results = await runQuery(this.db, ONE_SQL, { id });
    const [rows, log] = results.slice(-2) as [DetailRow[], EntryRow[]];
    const s = rows[0];
    if (!s) throw new NotFoundException();
    res.setHeader('Cache-Control', 'private, no-store');
    return {
      ...toSummary(s),
      description: s.description,
      body: or(s.body),
      bylineName: or(s.bylineName),
      themes: s.themes.flatMap((t) =>
        t.name ? [{ id: t.id, name: t.name }] : [],
      ),
      media: (s.media ?? []).map((m) => ({
        format: m.format,
        bunnyVideoId: or(m.bunnyVideoId),
        thumbnailPath: or(m.thumbnailPath),
        width: or(m.width),
        height: or(m.height),
        durationSeconds: or(m.durationSeconds),
        processing: or(m.processing),
      })),
      image: s.image
        ? {
            path: s.image.path,
            width: s.image.width,
            height: s.image.height,
            alt: or(s.image.alt),
            processing: or(s.image.processing),
          }
        : null,
      socialMediaSharingConsent:
        s.sharingVersion != null && s.sharingAt
          ? {
              version: s.sharingVersion,
              agreedAt: iso(s.sharingAt) as string,
            }
          : null,
      statusLog: log.map((e) => ({
        id: recordKey(e.id),
        status: e.status,
        actor: e.actor,
        by: or(e.by),
        comment: or(e.comment),
        storyVersion: e.storyVersion,
        at: iso(e.at) as string,
        publishedAt: iso(e.publishedAt),
        hiddenReason: or(e.hiddenReason),
      })),
    };
  }
}

@Module({ controllers: [AllStoriesController] })
export class AllStoriesModule {}
