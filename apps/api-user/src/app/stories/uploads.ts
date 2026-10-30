import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { recordKey } from '@heisreal/consent';
import {
  DatabaseQueryError,
  IdempotencyKeyReusedError,
  type IdempotencyScope,
  type IdempotentResponse,
  type PreparedCommand,
  retryOnConflict,
  runIdempotent,
  runQuery,
  uploadLimitOf,
  WriteNotAppliedError,
} from '@heisreal/database';
import type { RecordId, SurrealQueryable } from 'surrealdb';
import type { BunnyStream, SignedUpload } from './bunny-stream';
import { StaleVersionException } from './story-store';

/**
 * Video and audio uploads (M2 plan PR 7; D65, D68, D80, D113): RequestUpload, and the checks
 * SubmitStory makes on a video or audio story's file.
 *
 * - api-user creates the video at Bunny (title = the story id, D69), then on its own login records
 *   an upload grant, whose event puts the video on the person's draft in the same write (D80): the
 *   browser never names a video, and the TUS link it gets binds only that video.
 * - One video per draft: a new file replaces the draft's video, and the old one is deleted at
 *   Bunny at once (nobody reviewed it). A resume signs the draft's own video again, only while
 *   nothing has arrived for it, and only once its grant's renewal commits: that counts as
 *   touching the draft, so housekeeping doesn't delete it as abandoned (D71).
 * - The TUS link bounds neither size nor type (D68), so the person's limits (D113, admin
 *   settings) are checked before anything is created at Bunny, by the database again when the
 *   grant is written, and at submit with the limits in force then and Bunny's own length.
 */

export interface UploadRequest {
  format: 'video' | 'audio';
  contentType: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  resume: boolean;
}

/** The contract's `UploadTarget`. */
export interface UploadTarget extends SignedUpload {
  id: string;
  version: number;
  provider: 'bunny_tus';
  method: 'POST';
}

/** A4: video MP4/MOV/WebM, audio MP3/M4A/WAV (browsers name some of them two ways). */
export const CONTENT_TYPES: Record<UploadRequest['format'], readonly string[]> =
  {
    video: ['video/mp4', 'video/quicktime', 'video/webm'],
    audio: [
      'audio/mpeg',
      'audio/mp4',
      'audio/x-m4a',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
    ],
  };

/** Bunny statuses (bunny-stream.ts): nothing uploaded yet, and an upload that failed. */
const NOT_UPLOADED = [0, 6];
/** Uploaded, processing, transcoding, finished, couldn't be encoded, just-in-time stages. */
const ARRIVED = [1, 2, 3, 4, 5, 7, 8];
const ENCODING_FAILED = 5;

interface FieldError {
  pointer: string;
  message: string;
}

function invalid(
  errors: FieldError[],
  message = 'The upload isn’t valid',
): never {
  throw new BadRequestException({ code: 'validation_failed', message, errors });
}

const posInt = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function parseUploadRequest(body: unknown): UploadRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid([{ pointer: '', message: 'a JSON object' }]);
  }
  const b = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  const known = [
    'format',
    'contentType',
    'fileSizeBytes',
    'durationSeconds',
    'resume',
  ];
  for (const k of Object.keys(b)) {
    if (!known.includes(k))
      errors.push({ pointer: `/${k}`, message: 'unknown field' });
  }
  if (b['format'] !== 'video' && b['format'] !== 'audio') {
    errors.push({ pointer: '/format', message: 'video or audio' });
  }
  const format = b['format'] as UploadRequest['format'];
  if (
    typeof b['contentType'] !== 'string' ||
    (CONTENT_TYPES[format] && !CONTENT_TYPES[format].includes(b['contentType']))
  ) {
    errors.push({
      pointer: '/contentType',
      message:
        format === 'audio'
          ? 'an MP3, M4A or WAV file'
          : 'an MP4, MOV or WebM file',
    });
  }
  if (!posInt(b['fileSizeBytes'])) {
    errors.push({
      pointer: '/fileSizeBytes',
      message: 'the file’s size in bytes',
    });
  }
  if (b['durationSeconds'] !== undefined && !posInt(b['durationSeconds'])) {
    errors.push({
      pointer: '/durationSeconds',
      message: 'whole seconds, at least 1',
    });
  }
  if (b['resume'] !== undefined && typeof b['resume'] !== 'boolean') {
    errors.push({ pointer: '/resume', message: 'true or false' });
  }
  if (errors.length) invalid(errors);
  return {
    format,
    contentType: b['contentType'] as string,
    fileSizeBytes: b['fileSizeBytes'] as number,
    durationSeconds: b['durationSeconds'] as number | undefined,
    resume: b['resume'] === true,
  };
}

/** fn::limits::effective's upload half. */
interface UploadLimits {
  videoMaxBytes: number;
  audioMaxBytes: number;
  mediaMaxSeconds: number;
}

interface DraftMedia {
  version: number;
  status: string;
  primaryFormat: string;
  videoId?: string;
}

const EDITABLE = ['draft', 'changes_requested'];

export class Uploads {
  private readonly logger = new Logger('Uploads');

  constructor(
    /** api-user's own login: only it creates upload grants (D80). */
    private readonly service: SurrealQueryable,
    private readonly bunny: BunnyStream | null,
  ) {}

  private stream(): BunnyStream {
    if (!this.bunny) {
      throw new ServiceUnavailableException({
        code: 'uploads_unavailable',
        message: 'Uploading isn’t available right now. Your story is saved.',
      });
    }
    return this.bunny;
  }

  /**
   * RequestUpload on the person's draft `id` at version `ifMatch`, once per Idempotency-Key (D29):
   * a new file's grant is counted against the person's upload limits, so a retry after a lost
   * answer replays the same video and version instead of starting (and counting) another.
   */
  async request(
    person: SurrealQueryable,
    user: RecordId,
    id: string,
    ifMatch: number,
    input: UploadRequest,
    idempotency: { key: string; requestHash: string },
  ): Promise<UploadTarget> {
    const bunny = this.stream();
    if (input.resume) {
      const draft = await this.checkDraft(person, id, ifMatch, input);
      // The same video again, for a new link (after a reload, or once the last one expired).
      await this.checkResumable(person, id, draft.videoId);
      await this.renew(user, id, draft.videoId as string);
      return this.target(bunny, id, draft.version, draft.videoId as string);
    }

    const scope: IdempotencyScope = {
      service: 'api-user',
      owner: user,
      key: idempotency.key,
    };
    // Made at Bunny once, on the first attempt that gets that far; a conflict's retry reuses it.
    let videoId: string | undefined;
    let replaced: string | undefined;
    const prepare = async (): Promise<PreparedCommand> => {
      const draft = await this.checkDraft(person, id, ifMatch, input);
      const availableAt = await this.nextAllowedAt(person);
      if (availableAt) throw limitReached(availableAt);
      videoId ??= await bunny.createVideo(id);
      replaced = draft.videoId;
      return {
        status: 200,
        // The grant's event attaches the video; it's the story's only version step (D29).
        statements: `LET $grant = (CREATE ONLY type::record('uploadGrant', $video) CONTENT {
            story: type::record('story', $id), person: $person, format: $format,
            contentType: $contentType, sizeBytes: $size, durationSeconds: $duration,
            storyVersion: $version
          } RETURN id, storyVersion);
          IF $grant = NONE { THROW 'upload_refused: upload grant not written' };
          LET $result = { id: $grant.id, version: $grant.storyVersion + 1 };`,
        vars: {
          video: videoId,
          id,
          person: user,
          format: input.format,
          contentType: input.contentType,
          size: input.fileSizeBytes,
          duration: input.durationSeconds,
          version: ifMatch,
        },
      };
    };

    let outcome: { response: IdempotentResponse; replayed: boolean };
    try {
      outcome = await runIdempotent(
        this.service,
        scope,
        idempotency.requestHash,
        prepare,
      );
    } catch (err) {
      if (definite(err)) {
        // The database answered: nothing was written, so the video made for it is nobody's.
        if (videoId) await this.discard(videoId, 'a refused upload');
        throw await this.refusal(err, person);
      }
      // No answer (a lost connection, a timeout): the grant may have committed with the video
      // on the draft. Never delete it; look the key up again, which commits with the grant.
      outcome = await this.reconcile(
        scope,
        idempotency.requestHash,
        videoId,
        err,
      );
    }
    const granted = recordKey(outcome.response.id);
    const version = outcome.response.version ?? ifMatch + 1;
    if (!outcome.replayed || granted === videoId) {
      // This request's own grant: the draft's previous file was replaced before anyone
      // reviewed it, so it goes at once (M2 plan PR 7).
      if (replaced && replaced !== granted) {
        await this.discard(replaced, 'a replaced video');
      }
    } else {
      if (videoId && videoId !== granted) {
        // Another attempt with this key had committed first (a racing retry): ours is unused.
        await this.discard(videoId, 'an unused video');
      }
      // A replay signs a link only as a resume would: the story still editable, the video
      // still its file, and nothing arrived for it yet. Never a link once it's submitted, nor
      // for a file the limits in force now refuse (its version may be stale; its file may not).
      this.checkFile(input, await this.limits(person));
      await this.checkResumable(person, id, granted);
      await this.renew(user, id, granted);
    }
    return this.target(bunny, id, version, granted);
  }

  /**
   * After a write with no answer: the key's stored response if it committed (its grant and the
   * video on the draft went with it), else `503`, keeping the video. Trying again with the same
   * key then replays it, or makes the upload, without counting a second one.
   */
  private async reconcile(
    scope: IdempotencyScope,
    hash: string,
    videoId: string | undefined,
    cause: unknown,
  ): Promise<{ response: IdempotentResponse; replayed: boolean }> {
    try {
      return await runIdempotent(this.service, scope, hash, async () => {
        throw new OutcomeUnknown();
      });
    } catch (err) {
      this.logger.warn(
        `Upload grant${videoId ? ` for video ${videoId}` : ''} has no known outcome; video kept (an orphan until the sweep if it never committed): ${String(cause)}`,
      );
      if (err instanceof IdempotencyKeyReusedError) throw err;
      throw new ServiceUnavailableException({
        code: 'upload_outcome_unknown',
        message:
          'We couldn’t confirm your upload started. Your story is saved; please try again.',
      });
    }
  }

  /**
   * A link for `videoId` again only while the story is editable, that video is still its file,
   * and nothing has arrived for it: a finished file can't be uploaded over (`409`).
   */
  private async checkResumable(
    person: SurrealQueryable,
    id: string,
    videoId: string | undefined,
  ): Promise<void> {
    const draft = await this.draft(person, id);
    if (!EDITABLE.includes(draft.status)) throw locked();
    const video =
      videoId && draft.videoId === videoId
        ? await this.stream().video(videoId)
        : null;
    if (!video || !NOT_UPLOADED.includes(video.status)) throw nothingToResume();
  }

  /**
   * Before a link for an existing grant is signed again: its renewal (fn::upload::renew) counts
   * as touching the draft (D71). It conflicts with housekeeping deleting the draft as abandoned,
   * so if the deletion wins, the retry finds no draft and no link is signed.
   */
  private async renew(user: RecordId, id: string, videoId: string) {
    let renewed: unknown;
    try {
      [renewed] = await retryOnConflict(() =>
        runQuery(
          this.service,
          `RETURN fn::upload::renew(type::record('story', $id), $person, $video)`,
          { id, person: user, video: videoId },
        ),
      );
    } catch (err) {
      const message =
        err instanceof DatabaseQueryError ? err.message : String(err);
      if (/story_cmd:locked/.test(message)) throw locked();
      if (/nothing_to_resume/.test(message)) throw nothingToResume();
      throw err;
    }
    if (!renewed) throw nothingToResume();
  }

  private async discard(videoId: string, what: string) {
    await this.stream()
      .deleteVideo(videoId)
      .catch((e: unknown) =>
        this.logger.warn(
          `Couldn’t delete ${what} ${videoId} (an orphan until the sweep): ${String(e)}`,
        ),
      );
  }

  /** The draft at `ifMatch`, still editable and of the request's format. */
  private async checkDraft(
    person: SurrealQueryable,
    id: string,
    ifMatch: number,
    input: UploadRequest,
  ): Promise<DraftMedia> {
    const draft = await this.draft(person, id);
    if (draft.version !== ifMatch) throw new StaleVersionException();
    if (!EDITABLE.includes(draft.status)) throw locked();
    if (draft.primaryFormat !== input.format) {
      invalid([
        {
          pointer: '/format',
          message: `this is a ${draft.primaryFormat} story`,
        },
      ]);
    }
    this.checkFile(input, await this.limits(person));
    return draft;
  }

  /**
   * SubmitStory's checks on a video or audio story (D80, D113): its file has arrived at Bunny
   * (`409 media_not_uploaded`), Bunny could read it (`409 media_failed`), and it's within the
   * limits in force now (`409 media_over_limit`): "new rules apply to everyone" (Joel,
   * 2026-10-30), so a draft started under older limits is checked against today's.
   */
  async checkBeforeSubmit(person: SurrealQueryable, id: string): Promise<void> {
    const draft = await this.draft(person, id);
    if (draft.primaryFormat === 'written') return;
    const bunny = this.stream();
    const notUploaded = () =>
      new ConflictException({
        code: 'media_not_uploaded',
        message: `Your ${draft.primaryFormat} hasn’t finished uploading yet. Upload it, then submit your story.`,
      });
    if (!draft.videoId) throw notUploaded();
    const [grant] = (await runQuery(
      person,
      `SELECT sizeBytes, durationSeconds, format FROM ONLY type::record('uploadGrant', $v)`,
      { v: draft.videoId },
    )) as [
      { sizeBytes: number; durationSeconds?: number; format: string } | null,
    ];
    const video = await bunny.video(draft.videoId);
    // Only a status Bunny documents as "the file is there" counts; anything else (none yet, a
    // failed upload, a status added later) is not uploaded: fail closed.
    if (!grant || !video || !ARRIVED.includes(video.status)) {
      throw notUploaded();
    }
    if (video.status === ENCODING_FAILED) {
      throw new ConflictException({
        code: 'media_failed',
        message: `We couldn’t read that ${draft.primaryFormat} file. Please upload it again, or try another file.`,
      });
    }
    // The length is Bunny's own once it has read the file; until then the declared one can't be
    // trusted (the TUS link binds neither size nor length, D68), so submit waits for it.
    if (!(video.length > 0)) {
      throw new ConflictException({
        code: 'media_processing',
        message: `We’re still checking your ${draft.primaryFormat}. Please try again in a minute.`,
      });
    }
    const limits = await this.limits(person);
    const maxBytes =
      grant.format === 'audio' ? limits.audioMaxBytes : limits.videoMaxBytes;
    const seconds = Math.max(
      grant.durationSeconds ?? 0,
      Math.ceil(video.length),
    );
    if (grant.sizeBytes > maxBytes || seconds > limits.mediaMaxSeconds) {
      throw new ConflictException({
        code: 'media_over_limit',
        message: `Your ${draft.primaryFormat} is ${
          grant.sizeBytes > maxBytes ? 'bigger' : 'longer'
        } than we can take now. Please upload a ${
          grant.sizeBytes > maxBytes ? 'smaller' : 'shorter'
        } one, then submit your story.`,
      });
    }
  }

  private async draft(
    person: SurrealQueryable,
    id: string,
  ): Promise<DraftMedia> {
    const [rows] = (await runQuery(
      person,
      `SELECT version, status, primaryFormat, media[0].bunnyVideoId AS videoId
         FROM type::record('story', $id)`,
      { id },
    )) as [DraftMedia[]];
    if (!rows.length) throw new NotFoundException();
    return rows[0];
  }

  private async limits(person: SurrealQueryable): Promise<UploadLimits> {
    const [limits] = (await runQuery(
      person,
      'RETURN fn::limits::effective($auth)',
    )) as [UploadLimits];
    return limits;
  }

  private async nextAllowedAt(
    person: SurrealQueryable,
  ): Promise<string | undefined> {
    const [at] = (await runQuery(
      person,
      'RETURN fn::upload::next_allowed_at($auth)',
    )) as [string | null | undefined];
    return at ? new Date(at).toISOString() : undefined;
  }

  private checkFile(input: UploadRequest, limits: UploadLimits) {
    const maxBytes =
      input.format === 'audio' ? limits.audioMaxBytes : limits.videoMaxBytes;
    const errors: FieldError[] = [];
    if (input.fileSizeBytes > maxBytes) {
      errors.push({
        pointer: '/fileSizeBytes',
        message: `at most ${maxBytes} bytes`,
      });
    }
    if (
      input.durationSeconds !== undefined &&
      input.durationSeconds > limits.mediaMaxSeconds
    ) {
      errors.push({
        pointer: '/durationSeconds',
        message: `at most ${limits.mediaMaxSeconds} seconds`,
      });
    }
    if (errors.length) invalid(errors, 'The file is over the limits');
  }

  private target(
    bunny: BunnyStream,
    id: string,
    version: number,
    videoId: string,
  ): UploadTarget {
    return {
      id,
      version,
      provider: 'bunny_tus',
      method: 'POST',
      ...bunny.sign(videoId),
    };
  }

  /** The database's refusals of a grant (the API's checks can lose a race) as problems. */
  private async refusal(
    err: unknown,
    person: SurrealQueryable,
  ): Promise<unknown> {
    if (err instanceof HttpException) return err;
    const limit = uploadLimitOf(err);
    if (limit === 'hourly' || limit === 'weekly') {
      const at = await this.nextAllowedAt(person).catch(() => undefined);
      return limitReached(at ?? new Date(Date.now() + 3600_000).toISOString());
    }
    if (limit) {
      return new BadRequestException({
        code: 'validation_failed',
        message: 'The file is over the limits',
        errors: [
          limit === 'size'
            ? { pointer: '/fileSizeBytes', message: 'bigger than allowed' }
            : { pointer: '/durationSeconds', message: 'longer than allowed' },
        ],
      });
    }
    const message =
      err instanceof DatabaseQueryError ? err.message : String(err);
    if (/story_cmd:stale_version/.test(message))
      return new StaleVersionException();
    if (/story_cmd:locked/.test(message)) return locked();
    if (/needs the submitter’s current Art 9/.test(message)) {
      return new ForbiddenException({
        code: 'consent_required',
        message: 'Uploading needs your current consent',
      });
    }
    return err;
  }
}

/** Thrown by the reconciling lookup's command: it never writes. */
class OutcomeUnknown extends Error {}

/**
 * The database answered, so the grant's write definitely didn't commit: a refusal (a THROW, a
 * conflict, a key used for another request), or a check before it. Anything else (no answer)
 * leaves it unknown.
 */
function definite(err: unknown): boolean {
  return (
    err instanceof HttpException ||
    err instanceof DatabaseQueryError ||
    err instanceof WriteNotAppliedError ||
    err instanceof IdempotencyKeyReusedError
  );
}

function nothingToResume() {
  return new ConflictException({
    code: 'nothing_to_resume',
    message:
      'There’s no unfinished upload on this story to carry on with. Choose the file again to upload it.',
  });
}

function locked() {
  return new ConflictException({
    code: 'story_locked',
    message: 'A story can’t be changed once it’s submitted',
  });
}

function limitReached(availableAt: string) {
  return new HttpException(
    {
      code: 'upload_limit_reached',
      message:
        'You’ve started as many uploads as you can for now. Your story is saved, so you can upload later.',
      availableAt,
    },
    HttpStatus.CONFLICT,
  );
}
