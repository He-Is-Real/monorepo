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
import {
  DatabaseQueryError,
  retryOnConflict,
  runQuery,
  uploadLimitOf,
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
 *   nothing has arrived for it.
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

  /** RequestUpload on the person's draft `id` at version `ifMatch`. */
  async request(
    person: SurrealQueryable,
    user: RecordId,
    id: string,
    ifMatch: number,
    input: UploadRequest,
  ): Promise<UploadTarget> {
    const bunny = this.stream();
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

    if (input.resume) {
      // The same video again, for a new link (after a reload, or once the last one expired),
      // only while nothing has arrived for it: a finished file can't be uploaded over.
      const video = draft.videoId ? await bunny.video(draft.videoId) : null;
      if (!draft.videoId || !video || !NOT_UPLOADED.includes(video.status)) {
        throw new ConflictException({
          code: 'nothing_to_resume',
          message:
            'There’s no unfinished upload on this story to carry on with. Choose the file again to upload it.',
        });
      }
      return this.target(bunny, id, draft.version, draft.videoId);
    }

    const availableAt = await this.nextAllowedAt(person);
    if (availableAt) throw limitReached(availableAt);
    const videoId = await bunny.createVideo(id);
    let version: number;
    try {
      version = await retryOnConflict(() =>
        this.grant(user, id, ifMatch, videoId, input),
      );
    } catch (err) {
      await bunny
        .deleteVideo(videoId)
        .catch((e: unknown) =>
          this.logger.warn(
            `Couldn’t delete video ${videoId} after a refused upload (an orphan until the sweep): ${String(e)}`,
          ),
        );
      throw await this.refusal(err, person);
    }
    if (draft.videoId) {
      // Replaced before anyone reviewed it: gone at once (M2 plan PR 7).
      await bunny
        .deleteVideo(draft.videoId)
        .catch((e: unknown) =>
          this.logger.warn(
            `Couldn’t delete replaced video ${draft.videoId} (an orphan until the sweep): ${String(e)}`,
          ),
        );
    }
    return this.target(bunny, id, version, videoId);
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

  /** The grant, on api-user's own login; its event attaches the video (D80). */
  private async grant(
    user: RecordId,
    id: string,
    version: number,
    videoId: string,
    input: UploadRequest,
  ): Promise<number> {
    const [written] = (await runQuery(
      this.service,
      `CREATE type::record('uploadGrant', $video) CONTENT {
         story: type::record('story', $id), person: $person, format: $format,
         contentType: $contentType, sizeBytes: $size, durationSeconds: $duration,
         storyVersion: $version
       } RETURN VALUE storyVersion`,
      {
        video: videoId,
        id,
        person: user,
        format: input.format,
        contentType: input.contentType,
        size: input.fileSizeBytes,
        duration: input.durationSeconds,
        version,
      },
    )) as [number[]];
    if (written?.length !== 1) throw new Error('upload grant not written');
    // The event's write is the story's only version step (D29).
    return version + 1;
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
