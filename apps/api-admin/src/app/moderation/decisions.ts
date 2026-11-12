import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  isMediaNotReadyError,
  isTransactionConflict,
  retryOnConflict,
  runQuery,
  trimmedTextLength,
} from '@heisreal/database';
import { ProblemException } from '@heisreal/http';
import type { RecordId, Surreal } from 'surrealdb';

/**
 * The moderators' decisions (M3 plan PR 6; Joel, 2026-11-11: M3 basics, G5, G11 B, G14 B, G24,
 * D-1). Each adds one entry to the story's status log (R6), whose own rules (storyStatusLog_step)
 * check the step against the story's state, the note, the media wait and the testimony consent,
 * and move the story. Moderators decide straight from `pending` (no pick-up).
 */
export type Decision =
  | 'approved'
  | 'changesRequested'
  | 'rejected'
  | 'hiddenByModerator'
  | 'shownByModerator';

/** Longest note a moderator may leave (Joel's plan: 1–2000 characters). */
export const NOTE_MAX = 2000;

/**
 * G14 B (Joel, 2026-11-11): a decision is about what the moderator looked at, so it names the
 * story's current status entry and the files the review page showed, never the edit number
 * (background work changes the version without changing what was reviewed, and a picture video
 * replaces the file without it). Sent back in `If-Match` as an opaque tag.
 */
export interface Reviewed {
  entry: string;
  media: string | null;
  image: string | null;
}

export function reviewTag(r: Reviewed): string {
  return Buffer.from(JSON.stringify([r.entry, r.media, r.image])).toString(
    'base64url',
  );
}

/** `If-Match: "<reviewTag>"`; `undefined` when missing, `'invalid'` when it isn't one of ours. */
export function parseReviewTag(
  header: string | undefined,
): Reviewed | undefined | 'invalid' {
  if (header === undefined || header.trim() === '') return undefined;
  const m = /^"([A-Za-z0-9_-]{1,2048})"$/.exec(header.trim());
  if (!m) return 'invalid';
  try {
    const parts = JSON.parse(
      Buffer.from(m[1], 'base64url').toString('utf8'),
    ) as unknown;
    if (
      Array.isArray(parts) &&
      parts.length === 3 &&
      typeof parts[0] === 'string' &&
      parts[0] !== '' &&
      parts.slice(1).every((p) => p === null || typeof p === 'string')
    ) {
      return {
        entry: parts[0],
        media: parts[1] as string | null,
        image: parts[2] as string | null,
      };
    }
  } catch {
    // fall through
  }
  return 'invalid';
}

/**
 * One decision, in one transaction: refused unless the story still points at the status entry and
 * the files the moderator reviewed (G14 B), then the entry, which the database checks and which
 * moves the story. Two moderators at once write the same fence (the story's owner's), so the second
 * conflicts at commit; its retry finds the story's entry changed: "already decided" (D-1). Answers
 * the story's version and what the next decision names.
 */
const DECIDE_SQL = `BEGIN TRANSACTION;
  LET $story = type::record('story', $id);
  LET $s = (SELECT currentStatus, currentStatus.actor AS actor, mediaFile,
    image.file AS imageFile FROM ONLY $story);
  IF $s = NONE { THROW 'moderation_cmd:not_found' };
  IF $s.currentStatus != type::record('storyStatusLog', $entry) {
    IF $s.actor = 'moderator' { THROW 'moderation_cmd:decided' };
    THROW 'moderation_cmd:changed';
  };
  IF $s.mediaFile != (IF $media != NONE { type::record('storyFile', $media) })
    OR $s.imageFile != (IF $image != NONE { type::record('storyFile', $image) }) {
    THROW 'moderation_cmd:changed';
  };
  CREATE type::record('storyStatusLog', rand::ulid()) CONTENT {
    story: $story, action: $action, by: $by, comment: $comment, skippedMediaWait: $skip
  } RETURN NONE;
  SELECT version, record::id(currentStatus) AS entry,
    IF mediaFile != NONE { record::id(mediaFile) } AS media,
    IF image != NONE { record::id(image.file) } AS image
  FROM ONLY $story;
  COMMIT TRANSACTION;`;

interface Decided {
  version: number;
  entry: string;
  media?: string | null;
  image?: string | null;
}

const invalid = (pointer: string, message: string) =>
  new BadRequestException({
    code: 'validation_failed',
    message,
    errors: [{ pointer, message }],
  });

/** A moderator's note to the person or reason for hiding: 1–2000 characters, spaces trimmed. */
export function parseNote(body: unknown, field: string): string {
  const value =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== 'string' || trimmedTextLength(value) === 0) {
    throw invalid(`/${field}`, 'Write a note to go with this decision');
  }
  const note = value.trim();
  if ([...note].length > NOTE_MAX) {
    throw invalid(`/${field}`, `Keep the note to ${NOTE_MAX} characters`);
  }
  return note;
}

/** Approve and Show again: `approveAnyway` (Admin only) skips the processing wait. */
export function parseAnyway(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('', 'The body is an object');
  }
  const value = (body as Record<string, unknown>)['approveAnyway'];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw invalid('/approveAnyway', 'approveAnyway is true or false');
  }
  return value;
}

/** The time in a `media_recently_uploaded` refusal ("… it can be approved after <time>"). */
function availableAtOf(message: string): string | undefined {
  const at = /can be approved after (\S+)/.exec(message)?.[1];
  return at && !Number.isNaN(Date.parse(at))
    ? new Date(at).toISOString()
    : undefined;
}

/**
 * The database's refusals as problems (409 unless said), each with a stable code the web turns
 * into plain words (Joel, 2026-11-09: never codes to people). Anything else is thrown as it is.
 */
export function decisionProblem(err: unknown): unknown {
  if (err instanceof HttpException) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('moderation_cmd:not_found')) {
    return new NotFoundException();
  }
  if (
    message.includes('moderation_cmd:decided') ||
    isTransactionConflict(err)
  ) {
    return new ConflictException({
      code: 'already_decided',
      message: 'Another moderator has already decided this story',
    });
  }
  if (message.includes('moderation_cmd:changed')) {
    return new ProblemException(
      HttpStatus.PRECONDITION_FAILED,
      'stale_version',
      'Precondition failed',
      'This story changed since you opened it',
    );
  }
  if (/\bmedia_recently_uploaded:/.test(message)) {
    return new ConflictException({
      code: 'media_recently_uploaded',
      message: 'The story’s files were uploaded recently',
      availableAt: availableAtOf(message),
    });
  }
  if (/\bmedia_still_processing:/.test(message)) {
    return new ConflictException({
      code: 'media_still_processing',
      message: 'The story’s files are still being processed',
    });
  }
  if (isMediaNotReadyError(err)) {
    return new ConflictException({
      code: 'media_not_ready',
      message: 'The story’s files haven’t finished processing',
    });
  }
  if (/\btestimony_consent_required:/.test(message)) {
    return new ConflictException({
      code: 'testimony_consent_required',
      message: 'The person hasn’t agreed to the testimony consent',
    });
  }
  if (/\bstatus_step:/.test(message)) {
    return new ConflictException({
      code: 'wrong_status',
      message: 'The story’s state doesn’t allow this',
    });
  }
  return err;
}

/** Only an Admin approves anyway (G24). */
export function requireAdminForAnyway(anyway: boolean, role?: string): void {
  if (anyway && role !== 'Admin') {
    throw new ForbiddenException({
      code: 'role_required',
      message: 'Only an Admin can approve anyway',
      requiredRole: 'Admin',
    });
  }
}

/** Runs one decision; answers the story's version and the tag the next decision names. */
export async function decide(
  db: Surreal,
  input: {
    id: string;
    reviewed: Reviewed;
    action: Decision;
    by: RecordId;
    comment?: string;
    anyway?: boolean;
  },
): Promise<{ version: number; tag: string }> {
  const run = (skip: boolean) =>
    retryOnConflict(() =>
      runQuery(db, DECIDE_SQL, {
        id: input.id,
        entry: input.reviewed.entry,
        media: input.reviewed.media ?? undefined,
        image: input.reviewed.image ?? undefined,
        action: input.action,
        by: input.by,
        comment: input.comment,
        skip: skip ? true : undefined,
      }),
    );
  let results: unknown[];
  try {
    try {
      results = await run(input.anyway === true);
    } catch (err) {
      // Approve anyway when the wait has just ended: nothing to skip, so an ordinary approval.
      const message = err instanceof Error ? err.message : String(err);
      if (!input.anyway || !message.includes('status_step: skippedMediaWait')) {
        throw err;
      }
      results = await run(false);
    }
  } catch (err) {
    throw decisionProblem(err);
  }
  const row = results.at(-2) as Decided;
  return {
    version: row.version,
    tag: reviewTag({
      entry: row.entry,
      media: row.media ?? null,
      image: row.image ?? null,
    }),
  };
}
