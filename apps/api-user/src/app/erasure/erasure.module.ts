import {
  BadRequestException,
  Controller,
  Global,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CONSENT_WITHDRAWAL_ERASURE,
  type ConsentWithdrawalErasure,
  NoConsentRequired,
  PERSON_PASS_ISSUER,
} from '@heisreal/consent';
import { runQuery, SURREAL } from '@heisreal/database';
import { NoRoleRequired } from '@heisreal/roles';
import { SecretsService } from '@heisreal/secrets';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import {
  CLERK_BACKEND,
  CLERK_USER_ID,
  type ClerkBackend,
  createClerkBackend,
} from './clerk-backend';
import { BUNNY_STORAGE } from '../stories/bunny-storage';
import { Erasure, IMAGE_DELETER } from './erasure';
import { SvixVerificationError, verifySvix } from './svix';

const SVIX_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Clerk's webhooks (`POST /v1/webhooks/clerk`, D33): `user.deleted` erases the person (D39), as
 * Clerk deleting them means their token no longer exists (someone deleted their account in Clerk's
 * own panel, or Clerk's dashboard). Verified with the Svix signature over the raw body, never a
 * Clerk JWT, and deduplicated on `svix-id` (D29): a redelivery is acknowledged without running
 * again (erasure is idempotent anyway). Other events are acknowledged and ignored: we store
 * nothing from Clerk (D16).
 */
@NoRoleRequired('Clerk webhooks are signed by Svix, not by a person’s token')
@NoConsentRequired(
  'Clerk’s notice that an account was deleted needs no consent',
)
@Controller('v1/webhooks/clerk')
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(CLERK_BACKEND) private readonly clerk: ClerkBackend,
    private readonly erasure: Erasure,
  ) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async clerkWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ): Promise<void> {
    const key = await this.clerk.webhookKey();
    // Not set up yet: Svix retries for days, so nothing is lost once the secret is added.
    if (!key) throw new ServiceUnavailableException('Clerk webhooks are off');
    if (!req.rawBody)
      throw new Error('The raw body is missing (rawBody: true)');
    try {
      verifySvix(key, { id, timestamp, signature }, req.rawBody);
    } catch (err) {
      if (!(err instanceof SvixVerificationError)) throw err;
      this.logger.warn(`Refused a Clerk webhook: ${err.message}`);
      throw new BadRequestException({
        code: 'invalid_signature',
        message: 'The webhook signature was refused',
      });
    }
    if (!SVIX_ID.test(id as string)) {
      throw new BadRequestException({ code: 'validation_failed' });
    }
    const event = req.body as {
      type?: unknown;
      data?: { id?: unknown };
    } | null;
    if (event?.type !== 'user.deleted') return;
    const clerkUserId = event.data?.id;
    if (typeof clerkUserId !== 'string' || !CLERK_USER_ID.test(clerkUserId)) {
      throw new BadRequestException({ code: 'validation_failed' });
    }
    if (await this.seen(id as string)) return;
    await this.erasure.erase(clerkUserId, 'clerk_user_deleted');
    await this.remember(id as string);
  }

  private async seen(svixId: string): Promise<boolean> {
    const [found] = (await runQuery(
      this.db,
      `SELECT VALUE id FROM type::record('idempotencyKey', ['api-user', 'svix', $svixId])`,
      { svixId },
    )) as [unknown[]];
    return found.length > 0;
  }

  private async remember(svixId: string): Promise<void> {
    await runQuery(
      this.db,
      `UPSERT type::record('idempotencyKey', ['api-user', 'svix', $svixId])
         SET requestHash = 'clerk.user.deleted', status = 204 RETURN NONE`,
      { svixId },
    );
  }
}

/**
 * Erasure (M2 plan PR 11; D39, D40, D82): `Erasure` for "Delete my account" (AccountController),
 * the consent withdrawals that delete the account (libs/consent's `ERASING_WITHDRAWALS`) and
 * Clerk's webhook. Global, so the consent endpoints can reach it; its Clerk client also serves the
 * data download (ExportModule) and people's fresh passes (PersonSessions).
 */
@Global()
@Module({
  controllers: [ClerkWebhookController],
  providers: [
    Erasure,
    {
      provide: CLERK_BACKEND,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createClerkBackend(secrets),
    },
    // Fresh passes for libs/consent's PersonSessions (decision T, option B); null without the key.
    {
      provide: PERSON_PASS_ISSUER,
      inject: [CLERK_BACKEND],
      useFactory: (clerk: ClerkBackend) => clerk.passIssuer(),
    },
    // The images storage zone (M2 plan PR 10); null with image uploads off.
    { provide: IMAGE_DELETER, useExisting: BUNNY_STORAGE },
    {
      provide: CONSENT_WITHDRAWAL_ERASURE,
      inject: [Erasure],
      useFactory: (erasure: Erasure): ConsentWithdrawalErasure => ({
        erase: (clerkUserId) => erasure.erase(clerkUserId, 'consent_withdrawn'),
      }),
    },
  ],
  exports: [
    Erasure,
    CONSENT_WITHDRAWAL_ERASURE,
    CLERK_BACKEND,
    PERSON_PASS_ISSUER,
  ],
})
export class ErasureModule {}
