import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConsentChecker } from './consent-checker';
import { resolveConsentPolicy } from './consent.decorators';
import { PersonSessions } from './person';

/**
 * The global, fail-closed consent guard (D21), installed by `ConsentModule.forRoot()` in
 * api-user and api-admin:
 * - a route with neither decorator (or both) is refused with `500`: a misconfiguration never
 *   runs (the application also refuses to start, see `ConsentModule`);
 * - `@NoConsentRequired(reason)` passes;
 * - `@RequiresConsent` reads the ledger now (no cache, D18) and answers `403` unless every
 *   listed type is currently granted, `401` if the caller isn't signed in.
 *
 * The database enforces the same rules for writes in its events; this makes every route state
 * its choice and refuses before any work is done.
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  private readonly logger = new Logger(ConsentGuard.name);

  constructor(
    private readonly checker: ConsentChecker,
    private readonly people: PersonSessions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const resolved = resolveConsentPolicy(
      context.getHandler(),
      context.getClass(),
    );
    if (!resolved.ok) {
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} ${resolved.problem}`,
      );
      throw new InternalServerErrorException();
    }
    const { policy } = resolved;
    if (policy.kind === 'none') return true;

    const { requirement } = policy;
    const request = context.switchToHttp().getRequest<Request>();
    let granted: boolean;
    if (requirement.subject === 'caller') {
      granted = await this.people.run(request, ({ session }) =>
        this.checker.callerHas(session, requirement.types),
      );
    } else {
      const storyId = request.params?.[requirement.storyParam ?? 'id'];
      if (typeof storyId !== 'string' || !storyId) {
        throw new InternalServerErrorException();
      }
      granted = await this.checker.submitterHas(storyId, requirement.types);
    }
    if (!granted) {
      throw new ForbiddenException({
        code: 'consent_required',
        message: `This needs current consent: ${requirement.types.join(', ')}`,
        consentTypes: requirement.types,
        subject: requirement.subject,
      });
    }
    return true;
  }
}
