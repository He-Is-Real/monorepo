import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import {
  CONSENT_REQUIRED,
  ifNoneMatches,
  NoConsentRequired,
  parseIdempotencyKey,
  PersonSessions,
  RequiresConsent,
  weakETag,
} from '@heisreal/consent';
import {
  IdempotencyKeyReusedError,
  requestHash,
  SURREAL,
} from '@heisreal/database';
import { RequiresRole } from '@heisreal/roles';
import { SecretsService } from '@heisreal/secrets';
import { MediaUrls } from '@heisreal/story-cards';
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
import { parseCreate, parseIfMatch, parsePatch } from './story-input';
import {
  type CommandResult,
  IfMatchRequiredException,
  StaleVersionException,
  type StoryMine,
  StoryStore,
  type SubmissionLimits,
  type Tag,
} from './story-store';
import { parseUploadRequest, type UploadTarget, Uploads } from './uploads';

const STATUSES = [
  'draft',
  'pending',
  'in_review',
  'approved',
  'rejected',
  'changes_requested',
  'withdrawn',
];
const STORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

function storyId(id: string): string {
  if (!STORY_ID.test(id)) throw new NotFoundException();
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
      STORY_ID.test(id)
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
 * the person's own database session (D27), but for the upload grant on api-user's own login (D80). Consent is checked by the guard first and by the database (D21, D93); D94's
 * limits by the database (story_limits).
 */
@RequiresRole('User')
@Controller()
export class StoriesController {
  private readonly uploads: Uploads;

  constructor(
    private readonly people: PersonSessions,
    @Inject(SURREAL) service: Surreal,
    @Inject(BUNNY_STREAM) bunny: BunnyStream | null,
    @Inject(BUNNY_STORAGE) images: ImageStore | null,
    /** The draft's own image, signed for its owner (D52). */
    private readonly urls: MediaUrls,
  ) {
    this.uploads = new Uploads(service, bunny, images);
  }

  @Get('v1/tags')
  @NoConsentRequired(
    'the tag list is the same for everyone and holds no personal data',
  )
  async listStoryTags(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<{ data: Tag[] } | undefined> {
    const data = await this.people.run(req, ({ session }) =>
      new StoryStore(session).tags(),
    );
    return this.collection(res, { data }, ifNoneMatch);
  }

  @Get('v1/account/stories')
  @NoConsentRequired('reading your own stories (your right of access, Art 15)')
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
  @NoConsentRequired('reading the limits that apply to you (no testimony)')
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

  @Get('v1/account/stories/:id')
  @NoConsentRequired('reading your own story (your right of access, Art 15)')
  async getMyStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<StoryMine | undefined> {
    const story = await this.people.run(req, ({ session }) =>
      new StoryStore(session, this.urls).get(storyId(id)),
    );
    if (!story) throw new NotFoundException();
    const etag = `"${story.version}"`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return story;
  }

  @Post('v1/stories')
  @RequiresConsent(CONSENT_REQUIRED.createDraft)
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
  @RequiresConsent(CONSENT_REQUIRED.editDraft)
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
    res.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Post('v1/stories/:id/submit')
  @RequiresConsent(CONSENT_REQUIRED.submitStory)
  async submitStory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<CommandResult> {
    const sid = storyId(id);
    const version = ifMatchOf(ifMatch);
    const idempotencyKey = parseIdempotencyKey(key);
    const result = await this.people
      .run(req, ({ session, user }) =>
        new StoryStore(session).submit(
          sid,
          version,
          {
            scope: { service: 'api-user', owner: user, key: idempotencyKey },
            requestHash: requestHash(['POST', 'submit', sid, version]),
          },
          () => this.uploads.checkBeforeSubmit(session, sid),
        ),
      )
      .catch((err: unknown) => {
        throw reused(err);
      });
    res.status(HttpStatus.OK);
    res.setHeader('ETag', `"${result.version}"`);
    return result;
  }

  @Post('v1/stories/:id/upload-url')
  @RequiresConsent(CONSENT_REQUIRED.requestUpload)
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
      .run(req, ({ session, user }) =>
        this.uploads.request(session, user, sid, version, input, {
          key: idempotencyKey,
          requestHash: requestHash(['POST', 'upload-url', sid, version, input]),
        }),
      )
      .catch((err: unknown) => {
        throw reused(err);
      });
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

@Module({
  controllers: [StoriesController],
  providers: [
    {
      // Uploads (M2 plan PR 7): null when off (no BUNNY_STREAM_API_KEY_SECRET).
      provide: BUNNY_STREAM,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createBunnyStream(secrets),
    },
    {
      // Images (M2 plan PR 10): null when off (no BUNNY_STORAGE_PASSWORD_SECRET).
      provide: BUNNY_STORAGE,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createImageStore(secrets),
    },
  ],
})
export class StoriesModule implements NestModule {
  // EditStory takes JSON Merge Patch (D28), which Nest's JSON parser leaves alone.
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(mergePatchBody)
      .forRoutes({ path: 'v1/stories/:id', method: RequestMethod.PATCH });
  }
}
