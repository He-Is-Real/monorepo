import { runQuery } from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';

/**
 * The media worker's answer about one Bunny video (M2 plan item 13, D78), as it publishes it to
 * `media-results` (libs/contracts/openapi/worker.yaml, `MediaResult`). The worker never trusts
 * Bunny's notice: it asks Bunny itself, with the read-only key, and answers with what it found.
 * - `ready`: encoded, with its real facts; `title` is the video's title at Bunny, which is the
 *   story's id (D69), a second check that the video is that story's.
 * - `failed`: Bunny couldn't encode it.
 * - `encoding`: Bunny is still working on it (a re-encode, or a notice that came early).
 * - `gone`: Bunny has no such video (deleted).
 */
export type MediaResult =
  | {
      videoId: string;
      eventId?: string;
      outcome: 'ready';
      title: string;
      width: number;
      height: number;
      lengthSeconds: number;
      thumbnailFileName: string;
    }
  | {
      videoId: string;
      eventId?: string;
      outcome: 'failed' | 'encoding' | 'gone';
    };

/** What the writer did with an answer. */
export type MediaResultOutcome =
  /** It changed the file's row. */
  | 'written'
  /** The row already says this (a duplicate, a retry, the nightly re-check): nothing written. */
  | 'unchanged'
  /** Not a file any story shows now (unknown, replaced, removed, another story's): dropped. */
  | 'ignored';

export class InvalidMediaResult extends Error {
  override name = 'InvalidMediaResult';
}

/** A Bunny video id (a GUID), as api-user records it (storyFile:<guid>). */
const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One path segment at Bunny (fn::media::safe_segment), e.g. `thumbnail_1a2b3c4d.jpg`. */
const FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const OUTCOMES = ['ready', 'failed', 'encoding', 'gone'] as const;

const positiveInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;

/** The answer, checked field by field; throws {@link InvalidMediaResult} otherwise. */
export function parseMediaResult(input: unknown): MediaResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidMediaResult('not an object');
  }
  const m = input as Record<string, unknown>;
  if (typeof m['videoId'] !== 'string' || !VIDEO_ID.test(m['videoId'])) {
    throw new InvalidMediaResult('videoId is not a Bunny video id');
  }
  if (
    m['eventId'] !== undefined &&
    (typeof m['eventId'] !== 'string' || !EVENT_ID.test(m['eventId']))
  ) {
    throw new InvalidMediaResult('bad eventId');
  }
  const outcome = m['outcome'];
  if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    throw new InvalidMediaResult('unknown outcome');
  }
  const base = {
    videoId: m['videoId'],
    ...(m['eventId'] === undefined ? {} : { eventId: m['eventId'] as string }),
  };
  if (outcome !== 'ready') {
    return { ...base, outcome: outcome as 'failed' | 'encoding' | 'gone' };
  }
  const { title, width, height, lengthSeconds, thumbnailFileName } = m;
  if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
    throw new InvalidMediaResult('a ready answer needs the video’s title');
  }
  if (!positiveInt(width, 16_384) || !positiveInt(height, 16_384)) {
    throw new InvalidMediaResult('a ready answer needs a width and height');
  }
  if (!positiveInt(lengthSeconds, 7 * 24 * 3600)) {
    throw new InvalidMediaResult('a ready answer needs a length over 0');
  }
  if (
    typeof thumbnailFileName !== 'string' ||
    !FILE_NAME.test(thumbnailFileName) ||
    thumbnailFileName === '.' ||
    thumbnailFileName === '..'
  ) {
    throw new InvalidMediaResult(
      'a ready answer needs its thumbnail’s file name',
    );
  }
  return {
    ...base,
    outcome: 'ready',
    title,
    width,
    height,
    lengthSeconds,
    thumbnailFileName,
  };
}

/** The file's row as the writer reads it, and whether a story still shows it. */
interface FileRow {
  format: 'video' | 'audio' | 'image';
  storyId: string | null;
  shown: boolean;
  detachedAt?: string;
  removedAt?: string;
  processing?: string;
  width?: number;
  height?: number;
  lengthSeconds?: number;
  thumbnailPath?: string;
}

const READ_FILE = `
  SELECT format, detachedAt, removedAt, processing, width, height, lengthSeconds, thumbnailPath,
    IF record::exists(story) { <string> record::id(story) } AS storyId,
    record::exists(story) AND story.mediaFile = id AS shown
  FROM ONLY type::record('storyFile', $video)`;

/**
 * Only while the story still shows this file, checked again in the write itself, so a replace
 * between the read and the write leaves the new file alone. Its events then hide or show the
 * story again (fn::story::check_files) and step its version.
 */
const WRITE_FILE = `
  UPDATE type::record('storyFile', $video) MERGE $changes
    WHERE detachedAt = NONE AND removedAt = NONE AND record::exists(story) AND story.mediaFile = id
    RETURN VALUE id`;

/**
 * Applies the worker's answer to the storyFile row of that Bunny video, signed in as
 * service:workflow (the only login that may set a file's processing, A2). Nothing else: never
 * the story itself, never a picture's row. Writes nothing when the row already says the same,
 * and drops answers about files no story shows now. The database's own rules then hide an
 * approved story whose file failed, and show it again when the same file is ready.
 *
 * Steps, in order: find the file the answer is about (or drop it), then record its facts. A later
 * step (Joel, 2026-11-06, video-bundle-rethink part A: telling Bunny which picture a video with
 * its own picture shows, `storyFile.thumbnailOf`) goes after `recordFacts`, with the same row.
 */
export async function applyMediaResult(
  db: SurrealQueryable,
  result: MediaResult,
): Promise<MediaResultOutcome> {
  const row = await shownFile(db, result);
  if (!row) return 'ignored';
  return recordFacts(db, row, result);
}

/** The file's row, if the answer is about a video or audio file its story shows now. */
async function shownFile(
  db: SurrealQueryable,
  result: MediaResult,
): Promise<FileRow | null> {
  const [row] = (await runQuery(db, READ_FILE, {
    video: result.videoId,
  })) as [FileRow | undefined];
  if (
    !row ||
    (row.format !== 'video' && row.format !== 'audio') ||
    !row.shown ||
    row.detachedAt !== undefined ||
    row.removedAt !== undefined
  ) {
    return null;
  }
  // D69: every story video is titled with its story's id.
  if (result.outcome === 'ready' && result.title !== row.storyId) return null;
  return row;
}

/** Writes what differs from the row; nothing if it already says the same. */
async function recordFacts(
  db: SurrealQueryable,
  row: FileRow,
  result: MediaResult,
): Promise<MediaResultOutcome> {
  const changes = changesFor(row, result);
  if (Object.keys(changes).length === 0) return 'unchanged';
  const [written] = (await runQuery(db, WRITE_FILE, {
    video: result.videoId,
    changes,
  })) as [unknown[]];
  return written.length > 0 ? 'written' : 'ignored';
}

/** Only the fields that differ from what the row says. */
function changesFor(
  row: FileRow,
  result: MediaResult,
): Record<string, unknown> {
  const want: Record<string, unknown> =
    result.outcome === 'ready'
      ? row.format === 'video'
        ? {
            processing: 'ready',
            width: result.width,
            height: result.height,
            lengthSeconds: result.lengthSeconds,
            thumbnailPath: `${result.videoId}/${result.thumbnailFileName}`,
          }
        : // Audio: only its length. Bunny makes no picture from sound (its 1280 × 720
          // placeholder only), so the audio clip's picture and its size are set by the later
          // default-picture step (D127), and approval waits for them (A2).
          { processing: 'ready', lengthSeconds: result.lengthSeconds }
      : // A video deleted at Bunny while its story still shows it counts as failed (the plan's
        // "When things go wrong").
        { processing: result.outcome === 'encoding' ? 'processing' : 'failed' };
  return Object.fromEntries(
    Object.entries(want).filter(
      ([field, value]) => row[field as keyof FileRow] !== value,
    ),
  );
}
