import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  IdempotencyKeyReusedError,
  type IdempotentResponse,
  IdempotencyStore,
  requestHash,
  SURREAL,
} from '@heisreal/database';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';
import {
  ConsentConflictError,
  ConsentLedger,
  type ConsentState,
  type GrantConsentInput,
  recordKey,
} from './consent-ledger';
import { NoConsentRequired } from './consent.decorators';
import {
  CONSENT_MECHANISMS,
  CONSENT_TYPES,
  type ConsentType,
  isConsentMechanism,
  isConsentType,
} from './consent.types';
import { PersonSessions } from './person';

/** The contracts' `CommandResult`. */
export interface CommandResult {
  id: string;
  version: number | null;
}

const DPA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseGrantConsent(body: unknown): GrantConsentInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: { pointer: string; message: string }[] = [];
  if (!isConsentType(b['type'])) {
    errors.push({
      pointer: '/type',
      message: `one of ${CONSENT_TYPES.join(', ')}`,
    });
  }
  if (typeof b['dpaVersion'] !== 'string' || !DPA_ID.test(b['dpaVersion'])) {
    errors.push({
      pointer: '/dpaVersion',
      message: 'a DPA version id, e.g. v1',
    });
  }
  if (!isConsentMechanism(b['mechanism'])) {
    errors.push({
      pointer: '/mechanism',
      message: `one of ${CONSENT_MECHANISMS.join(', ')}`,
    });
  }
  if (errors.length) {
    throw new BadRequestException({ code: 'validation_failed', errors });
  }
  return {
    type: b['type'] as ConsentType,
    dpaVersion: b['dpaVersion'] as string,
    mechanism: b['mechanism'] as GrantConsentInput['mechanism'],
  };
}

export function parseIdempotencyKey(header: string | undefined): string {
  if (!header || header.length < 16 || header.length > 128) {
    throw new BadRequestException({
      code: 'idempotency_key_required',
      message:
        'This command needs an Idempotency-Key header (16–128 characters)',
    });
  }
  return header;
}

/** A weak, representation-based validator for composite views (D29). */
export function weakETag(body: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return `W/"${hash.slice(0, 32)}"`;
}

function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

/**
 * The person's consent endpoints (api-user, `libs/contracts/openapi/api-user.yaml`, tag
 * Consent). Everything runs in the person's own database session (D27).
 *
 * None of them requires consent: reading your own state, giving consent and withdrawing it
 * must all work without it (Art 7(3): withdrawing is as easy as giving).
 */
@Controller('v1/account/consents')
export class AccountConsentsController {
  private readonly idempotency: IdempotencyStore;

  constructor(
    private readonly people: PersonSessions,
    private readonly ledger: ConsentLedger,
    @Inject(SURREAL) service: Surreal,
  ) {
    // The idempotencyKey table is only open to the service's own login, not to the person.
    this.idempotency = new IdempotencyStore(service);
  }

  @Get()
  @NoConsentRequired('reading your own consent state and history')
  async getMyConsents(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<ConsentState | undefined> {
    const state = await this.people.run(req, ({ session }) =>
      this.ledger.state(session),
    );
    const etag = weakETag(state);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (matches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return state;
  }

  @Post()
  @NoConsentRequired('granting consent is how consent is obtained')
  async grantConsent(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<CommandResult> {
    const idempotencyKey = parseIdempotencyKey(key);
    const input = parseGrantConsent(body);
    return this.command(
      req,
      res,
      idempotencyKey,
      ['POST', 'consents', input],
      (session) =>
        this.ledger.grant(session, input).then((id) => ({
          status: HttpStatus.CREATED,
          id: `consent:${id}`,
          version: null,
        })),
    );
  }

  @Post(':type/withdraw')
  @NoConsentRequired(
    'withdrawing consent must be as easy as giving it (Art 7(3))',
  )
  async withdrawConsent(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('type') type: string,
    @Headers('idempotency-key') key?: string,
  ): Promise<CommandResult> {
    if (!isConsentType(type)) {
      throw new BadRequestException({
        code: 'validation_failed',
        errors: [
          { pointer: '/type', message: `one of ${CONSENT_TYPES.join(', ')}` },
        ],
      });
    }
    const idempotencyKey = parseIdempotencyKey(key);
    return this.command(
      req,
      res,
      idempotencyKey,
      ['POST', 'withdraw', type],
      (session) =>
        this.ledger.withdraw(session, type).then((id) => ({
          status: HttpStatus.ACCEPTED,
          id: `consent:${id}`,
          version: null,
        })),
    );
  }

  /** Runs a ledger command as the person, once per Idempotency-Key (D29). */
  private async command(
    req: Request,
    res: Response,
    key: string,
    request: unknown,
    execute: (
      session: Parameters<ConsentLedger['grant']>[0],
    ) => Promise<IdempotentResponse>,
  ): Promise<CommandResult> {
    try {
      const { response } = await this.people.run(req, ({ session, user }) =>
        this.idempotency.run(
          { service: 'api-user', owner: user, key },
          requestHash(request),
          () => execute(session),
        ),
      );
      res.status(response.status);
      return { id: recordKey(response.id), version: response.version };
    } catch (err) {
      if (err instanceof ConsentConflictError) {
        throw new ConflictException({ code: err.code, message: err.message });
      }
      if (err instanceof IdempotencyKeyReusedError) {
        throw new UnprocessableEntityException({
          code: 'idempotency_key_reused',
          message: err.message,
        });
      }
      throw err;
    }
  }
}

/** The consent HTTP endpoints; api-user only. Requires `ConsentModule.forRoot()`. */
@Module({ controllers: [AccountConsentsController] })
export class AccountConsentsModule {}
