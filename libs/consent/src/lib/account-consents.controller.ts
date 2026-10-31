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
  Logger,
  Module,
  Optional,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IdempotencyKeyReusedError, requestHash } from '@heisreal/database';
import type { Request, Response } from 'express';
import {
  type CommandOutcome,
  ConsentConflictError,
  ConsentLedger,
  type ConsentState,
  type GrantConsentInput,
  type IdempotencyOptions,
} from './consent-ledger';
import type { PersonContext } from './person';
import { RequiresRole } from '@heisreal/roles';
import { NoConsentRequired } from './consent.decorators';
import {
  CONSENT_FORMS,
  CONSENT_MECHANISMS,
  CONSENT_TYPES,
  type ConsentType,
  isConsentForm,
  isConsentMechanism,
  isConsentType,
} from './consent.types';
import { PersonSessions } from './person';

/**
 * Withdrawing these deletes the whole account (D39, D88: the testimony consent, Art 9; D73: the
 * sign-up consent to store the account). The database commits an erasure request with the
 * withdrawal (consent_withdrawal_requests_erasure, which lists the same two), so the erasure
 * can't be lost: the service's erasure runs straight after, and the nightly housekeeping erases
 * anyone it missed. Withdrawing anything else (publishing, social sharing, 18+, the terms)
 * deletes nothing.
 */
export const ERASING_WITHDRAWALS: readonly ConsentType[] = [
  'special_category_religious',
  'account_data',
];

/** The service's erasure (api-user's EraseAccount), run after an erasing withdrawal. */
export interface ConsentWithdrawalErasure {
  erase(clerkUserId: string): Promise<void>;
}
export const CONSENT_WITHDRAWAL_ERASURE = Symbol('CONSENT_WITHDRAWAL_ERASURE');

/** The contracts' `CommandResult`. */
export interface CommandResult {
  id: string;
  version: number | null;
}

const FORM_VERSION = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseGrantConsent(body: unknown): GrantConsentInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: { pointer: string; message: string }[] = [];
  if (!isConsentForm(b['form'])) {
    errors.push({
      pointer: '/form',
      message: `one of ${CONSENT_FORMS.join(', ')}`,
    });
  }
  if (
    typeof b['formVersion'] !== 'string' ||
    !FORM_VERSION.test(b['formVersion'])
  ) {
    errors.push({
      pointer: '/formVersion',
      message: 'the form version shown, e.g. v1',
    });
  }
  if (!isConsentType(b['statement'])) {
    errors.push({
      pointer: '/statement',
      message: `one of ${CONSENT_TYPES.join(', ')}`,
    });
  }
  if (!isConsentMechanism(b['mechanism'])) {
    errors.push({
      pointer: '/mechanism',
      message: `one of ${CONSENT_MECHANISMS.join(', ')}`,
    });
  }
  // D122: the privacy policy (and terms of use) versions the page showed; a missing one is the
  // ledger's 409 (legal_document_not_in_force), so a page from an older release reloads.
  for (const name of ['privacyPolicyVersion', 'termsVersion']) {
    const v = b[name];
    if (v !== undefined && (typeof v !== 'string' || !FORM_VERSION.test(v))) {
      errors.push({ pointer: `/${name}`, message: 'a version id, e.g. v1' });
    }
  }
  const unknown = Object.keys(b).find(
    (k) =>
      ![
        'form',
        'formVersion',
        'statement',
        'mechanism',
        'privacyPolicyVersion',
        'termsVersion',
      ].includes(k),
  );
  if (unknown) {
    errors.push({
      pointer: `/${unknown}`,
      message: 'not a field of this command',
    });
  }
  if (errors.length) {
    throw new BadRequestException({ code: 'validation_failed', errors });
  }
  return {
    form: b['form'] as GrantConsentInput['form'],
    formVersion: b['formVersion'] as string,
    statement: b['statement'] as ConsentType,
    mechanism: b['mechanism'] as GrantConsentInput['mechanism'],
    ...(typeof b['privacyPolicyVersion'] === 'string'
      ? { privacyPolicyVersion: b['privacyPolicyVersion'] }
      : {}),
    ...(typeof b['termsVersion'] === 'string'
      ? { termsVersion: b['termsVersion'] }
      : {}),
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

/** Whether `If-None-Match` matches `etag` (weak comparison, RFC 9110 §13.1.2), so `304`. */
export function ifNoneMatches(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
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
 * must all work without it (Art 7(3): withdrawing is as easy as giving). Each needs the `User`
 * role, the contract's `x-required-role` (D1).
 */
@RequiresRole('User')
@Controller('v1/account/consents')
export class AccountConsentsController {
  private readonly logger = new Logger(AccountConsentsController.name);

  constructor(
    private readonly people: PersonSessions,
    private readonly ledger: ConsentLedger,
    @Optional()
    @Inject(CONSENT_WITHDRAWAL_ERASURE)
    private readonly erasure?: ConsentWithdrawalErasure,
  ) {}

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
    if (ifNoneMatches(ifNoneMatch, etag)) {
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
      (session, idempotency) => this.ledger.grant(session, input, idempotency),
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
    const result = await this.command(
      req,
      res,
      idempotencyKey,
      ['POST', 'withdraw', type],
      (session, idempotency) =>
        this.ledger.withdraw(session, type, idempotency),
    );
    if (ERASING_WITHDRAWALS.includes(type)) {
      // D88, D73: the account goes. The withdrawal is on the ledger (kept as proof) with an
      // erasure request; erase now, or housekeeping does it tonight.
      try {
        if (!this.erasure) throw new Error('this service can’t erase');
        const { clerkUserId } = await this.people.authenticate(req);
        await this.erasure.erase(clerkUserId);
      } catch (err) {
        this.logger.error(
          `Withdrew ${type}; the erasure stays requested for housekeeping: ${err instanceof Error ? err.message : 'error'}`,
        );
      }
    }
    return result;
  }

  /**
   * Runs a ledger command as the person, once per Idempotency-Key (D29). The key commits in the
   * same transaction as the ledger event (see `runIdempotent`).
   */
  private async command(
    req: Request,
    res: Response,
    key: string,
    request: unknown,
    execute: (
      session: PersonContext['session'],
      idempotency: IdempotencyOptions,
    ) => Promise<CommandOutcome>,
  ): Promise<CommandResult> {
    try {
      const outcome = await this.people.run(req, ({ session, user }) =>
        execute(session, {
          scope: { service: 'api-user', owner: user, key },
          requestHash: requestHash(request),
        }),
      );
      res.status(outcome.status);
      return { id: outcome.id, version: null };
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
