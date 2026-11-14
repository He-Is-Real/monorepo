import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Global,
  Headers,
  HttpStatus,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  RequestMethod,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isBlocked, PersonSessions } from '@heisreal/auth';
import {
  IdempotencyKeyReusedError,
  requestHash,
  SURREAL,
} from '@heisreal/database';
import {
  ifNoneMatches,
  isStoryId,
  parseIdempotencyKey,
  weakETag,
} from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import { SecretsService } from '@heisreal/secrets';
import { MediaUrls, type ThemeCategory } from '@heisreal/story-cards';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';
import {
  BUNNY_STORAGE,
  createImageStore,
  type ImageStore,
} from './bunny-storage';
import {
  BUNNY_STREAM,
  type BunnyStream,
  createBunnyStream,
} from './bunny-stream';
import { mergePatchBody } from './merge-patch-body';
import { senderIp } from './sender-ip';
import {
  parseCreate,
  parseIfMatch,
  parsePatch,
  parseSubmit,
} from './story-input';
import {
  type CommandResult,
  IfMatchRequiredException,
  StaleVersionException,
  type StoryMine,
  StoryStore,
  type SubmissionLimits,
} from './story-store';
import { parseUploadRequest, type UploadTarget, Uploads } from './uploads';
import {
  BunnyWebhookModule,
  MEDIA_JOBS,
  type MediaJobs,
  sendStoryJobs,
} from '../media/bunny-webhook';

const STATUSES = ['editing', 'pending', 'approved', 'hidden', 'rejected'];
/**
 * GetStory's links to the person's own video, audio and picture (M3 plan PR 2, P1b-2: Joel,
 * 2026-11-10): one hour, not rounded, never cached (`no-store`).
 */
const OWN_LINK_SECONDS = 60 * 60;

function storyId(id: string): string {
  if (!isStoryId(id)) throw new NotFoundException();
  return id;
}

function ifMatchOf(header: string | undefined): number {
  const v = parseIfMatch(header);
  if (v === undefined) throw new IfMatchRequiredException();
  if (v === 'invalid') throw new StaleVersionException();
  return v;
}

function encodeCursor(c: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id])).toString('base64url');
}

function decodeCursor(
  raw: string | undefined,
): { createdAt: string; id: string } | undefined {
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
      return { createdAt, id };
    }
  } catch {
    // fall through
  }
  throw new BadRequestException({
    code: 'validation_failed',
    message: 'The cursor isn’t one this service gave out',
    errors: [
      { pointer: '/cursor', message: 'a nextCursor from a previous page' },
    ],
  });
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'limit is 1–50',
      errors: [{ pointer: '/limit', message: '1–50' }],
    });
  }
  return n;
}

function reused(err: unknown): unknown {
  return err instanceof IdempotencyKeyReusedError
    ? new UnprocessableEntityException({
        code: 'idempotency_key_reused',
        message: err.message,
      })
    : err;
}

/**
 * The submit flow's routes (M2 plan PR 4, written stories; PR 7, video and audio; PR 10, images): the person's
 * own stories and the commands that create, edit, upload to and submit a draft. Everything runs in
 * the person's own database session (D27), but for the upload grant on api-user's own login (D80).
 * The database refuses the person's story writes until they have agreed to the latest terms of
 * use and testimony consent (plan 4e: 403, agreements.ts), and checks D94's limits (story_limits).
 */
@RequiresRole('User')
@Controller()
export class StoriesController {
  private readonly uploads: Uploads;
  private readonly service: Surreal;

  constructor(
    private readonly people: PersonSessions,
    @Inject(SURREAL) service: Surreal,
    @Inject(BUNNY_STREAM) bunny: BunnyStream | null,
    @Inject(BUNNY_STORAGE) images: ImageStore | null,
    /** The draft's own image, signed for its owner (D52). */
    private readonly urls: MediaUrls,
    /** The media checks and picture videos a submit or a picture change writes down. */
    @Inject(MEDIA_JOBS) private readonly jobs: MediaJobs | null,
  ) {
    this.service = service;
    this.uploads = new Uploads(service, bunny, images);
  }

  @Get('v1/themes')
  async listStoryThemes(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<{ data: ThemeCategory[] } | undefined> {
    const data = await this.people.run(req, ({ session }) =>
      new StoryStore(session).themes(),
    );
    return this.collection(res, { data }, ifNoneMatch);
  }

  @Get('v1/account/stories')
  async listMyStories(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'Unknown status',
        errors: [{ pointer: '/status', message: STATUSES.join(', ') }],
      });
    }
    const page = await this.people.run(req, ({ session }) =>
      new StoryStore(session, this.urls).list(
        status,
        parseLimit(limit),
        decodeCursor(cursor),
      ),
    );
    return this.collection(
      res,
      {
        data: page.data,
        nextCursor: page.next ? encodeCursor(page.next) : null,
      },
      ifNoneMatch,
    );
  }

  @Get('v1/account/limits')
  async getMySubmissionLimits(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<SubmissionLimits | undefined> {
    const limits = await this.people.run(req, ({ session }) =>
      new StoryStore(session).limits(),
    );
    return this.collection(res, limits, ifNoneMatch);
  }

  // Library-specific response (Nest's documented `@Res()` mode): this route answers its own
  // condition, so Express's automatic freshness check (req.fresh, which would turn an answer in
  // full into a 304) never sees a body to drop (Codex #212 rounds 2 and 3). Errors are still
  // thrown, so ProblemFilter and the interceptors answer them as on every other route.
  @Get('v1/account/stories/:id')
  async getMyStory(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    // The owner's own links last an hour (P1b-2; Go live: unpublished media an hour or less);
    // a reload gets fresh ones.
    const ownLinks = this.urls.expiringIn(OWN_LINK_SECONDS);
    const story = await this.people.run(req, ({ session }) =>
      new StoryStore(session, ownLinks).get(storyId(id)),
    );
    if (!story) throw new NotFoundException();
    // Whether the picture's file arrived: a fact from the storage zone, what the page counts as
    // finished (Codex #140 round 3). Its arrival doesn't step the version, so a picture not
    // there yet is never answered 304.
    if (story.image) {
      story.image.uploaded = await this.uploads.imageArrived(story.image.path);
    }
    // The version's ETag stays for If-Match, but an answer carrying signed links is never 304:
    // the copy the page holds may have links that have expired since (Codex #212 round 1).
    const signed =
      !!story.image?.url ||
      story.media.some((m) => m.playbackUrl || m.thumbnailUrl);
    const etag = `"${story.version}"`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (
      ifNoneMatches(ifNoneMatch, etag) &&
      story.image?.uploaded !== false &&
      !signed
    ) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    // In full, sent as it is: res.json/res.send would check req.fresh and drop the body.
    res
      .status(HttpStatus.OK)
      .type('json')
      .end(JSON.stringify(story satisfies StoryMine));
  }

  @Post('v1/stories')
  async createDraftStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<CommandResult> {
    const idempotencyKey = parseIdempotencyKey(key);
    const input = parseCreate(body);
    const result = await this.people
      .run(req, ({ session, user }) =>
        new StoryStore(session).create(input, {
          scope: { service: 'api-user', owner: user, key: idempotencyKey },
          requestHash: requestHash(['POST', 'stories', input]),
        }),
      )
      .catch((err: unknown) => {
        throw reused(err);
      });
    res.status(HttpStatus.CREATED);
    res.setHeader('Location', `/v1/account/stories/${result.id}`);
    res.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Patch('v1/stories/:id')
  async editStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ): Promise<CommandResult> {
    const sid = storyId(id);
    const version = ifMatchOf(ifMatch);
    const patch = parsePatch(body);
    const result = await this.people.run(req, ({ session }) =>
      new StoryStore(session).edit(sid, version, patch),
    );
    // A removed picture: an audio story's new picture video.
    if (patch.image === null) {
      await sendStoryJobs(this.service, this.jobs, sid);
    }
    res.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Post('v1/stories/:id/submit')
  async submitStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<CommandResult> {
    const sid = storyId(id);
    const version = ifMatchOf(ifMatch);
    const idempotencyKey = parseIdempotencyKey(key);
    const { socialMediaSharingConsent: share } = parseSubmit(body);
    // The block list (G21 D): a blocked email (the token's verified one) or IP address can't send
    // a story. The address is kept on the sent entry for 30 days, for Admins only.
    const ip = senderIp(req);
    const { email } = await this.people.authenticate(req);
    // Checked in each fresh attempt, after the media checks (which may wait on Bunny), so a block
    // added meanwhile is seen; never before the stored answer for this Idempotency-Key, so a send
    // that went through replays its success even after the sender was blocked.
    const checkNotBlocked = async () => {
      if (
        (await isBlocked(this.service, 'blockedEmail', email)) ||
        (await isBlocked(this.service, 'blockedIp', ip))
      ) {
        throw new ForbiddenException({
          code: 'blocked',
          message: 'This story can’t be sent',
        });
      }
    };
    const result = await this.people
      .run(
        req,
        ({ session, user, deadline }) =>
          new StoryStore(session).submit(
            sid,
            version,
            {
              scope: { service: 'api-user', owner: user, key: idempotencyKey },
              deadline,
              // The same key with or without the sharing is a different request (422).
              requestHash: requestHash(
                share
                  ? ['POST', 'submit', sid, version, share]
                  : ['POST', 'submit', sid, version],
              ),
            },
            async () => {
              await this.uploads.checkBeforeSubmit(session, sid);
              await checkNotBlocked();
            },
            // Plan 4e: the sharing box ticked at the end of the upload is recorded in the
            // submission's own write, or neither is.
            share?.version,
            ip,
          ),
        // Waits on Bunny for the file (decision T): a fresh pass, and a deadline for retries.
        'slow',
      )
      .catch((err: unknown) => {
        throw reused(err);
      });
    // A video or audio story's check before it can be approved.
    await sendStoryJobs(this.service, this.jobs, sid);
    res.status(HttpStatus.OK);
    res.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Post('v1/stories/:id/edit')
  async startEditingStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ): Promise<CommandResult> {
    const sid = storyId(id);
    const version = ifMatchOf(ifMatch);
    const result = await this.people.run(req, ({ session }) =>
      new StoryStore(session).startEditing(sid, version),
    );
    res.status(HttpStatus.OK);
    res.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Delete('v1/stories/:id')
  async deleteStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ): Promise<void> {
    const sid = storyId(id);
    const version = ifMatchOf(ifMatch);
    const { videos } = await this.people.run(req, ({ session }) =>
      new StoryStore(session).delete(sid, version),
    );
    // Only once the delete has committed: its media at Bunny (D71; media-runbook.md).
    await this.uploads.discardDeleted(videos);
    res.status(HttpStatus.NO_CONTENT);
  }

  @Post('v1/stories/:id/upload-url')
  async requestUploadUrl(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<UploadTarget> {
    const sid = storyId(id);
    const version = ifMatchOf(ifMatch);
    const idempotencyKey = parseIdempotencyKey(key);
    const input = parseUploadRequest(body);
    const target = await this.people
      .run(
        req,
        ({ session, user, deadline }) =>
          this.uploads.request(session, user, sid, version, input, {
            key: idempotencyKey,
            deadline,
            requestHash: requestHash([
              'POST',
              'upload-url',
              sid,
              version,
              input,
            ]),
          }),
        // Creates and deletes videos at Bunny (decision T): a fresh pass, and a deadline for retries.
        'slow',
      )
      .catch((err: unknown) => {
        throw reused(err);
      });
    // A new picture: an audio story's new picture video.
    if (input.format === 'image') {
      await sendStoryJobs(this.service, this.jobs, sid);
    }
    res.status(HttpStatus.OK);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', `"${target.version}"`);
    return target;
  }

  private collection<T>(
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
}

/**
 * Bunny Stream for uploads (M2 plan PR 7) and erasure's video deletions (D40): null when off (no
 * BUNNY_STREAM_API_KEY_SECRET). The images storage zone (M2 plan PR 10) for picture uploads and
 * erasure's picture deletions: null when off (no BUNNY_STORAGE_PASSWORD_SECRET).
 */
@Global()
@Module({
  providers: [
    {
      provide: BUNNY_STREAM,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createBunnyStream(secrets),
    },
    {
      provide: BUNNY_STORAGE,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createImageStore(secrets),
    },
  ],
  exports: [BUNNY_STREAM, BUNNY_STORAGE],
})
export class BunnyStreamModule {}

@Module({ imports: [BunnyWebhookModule], controllers: [StoriesController] })
export class StoriesModule implements NestModule {
  // EditStory takes JSON Merge Patch (D28), which Nest's JSON parser leaves alone.
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(mergePatchBody)
      .forRoutes({ path: 'v1/stories/:id', method: RequestMethod.PATCH });
  }
}
