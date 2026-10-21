import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { PersonSessions, type RegisteredRoute } from '@heisreal/consent';
import type { Request } from 'express';
import { hasRole, isRole, type Role } from './roles';

export const REQUIRES_ROLE = 'heisreal:requires-role';
export const NO_ROLE_REQUIRED = 'heisreal:no-role-required';

/**
 * The route needs the caller to hold `minimum` or a more privileged role (D1), read from the
 * verified session token's role claim. Matches `x-required-role` in the contract.
 */
export function RequiresRole(minimum: Role): ClassDecorator & MethodDecorator {
  if (!isRole(minimum))
    throw new Error(`@RequiresRole: unknown role ${minimum}`);
  return SetMetadata(REQUIRES_ROLE, minimum);
}

/**
 * The route deliberately has no minimum role (e.g. `/health`); `reason` says why. Where every
 * route must declare one (api-admin), it's listed by the role-listing test.
 */
export function NoRoleRequired(
  reason: string,
): ClassDecorator & MethodDecorator {
  if (reason.trim().length < 10) {
    throw new Error('@NoRoleRequired needs a real reason (10+ characters)');
  }
  return SetMetadata(NO_ROLE_REQUIRED, reason.trim());
}

export type RolePolicy =
  | { kind: 'requires'; minimum: Role }
  | { kind: 'none'; reason: string }
  | { kind: 'undeclared' };

/**
 * A route's role policy: at most one decorator, on the handler or its controller. Two (e.g.
 * one on each) is a misconfiguration.
 */
export function resolveRolePolicy(
  handler: object,
  controller: object,
): { ok: true; policy: RolePolicy } | { ok: false; problem: string } {
  const found: RolePolicy[] = [];
  for (const target of [handler, controller]) {
    const minimum = Reflect.getMetadata(REQUIRES_ROLE, target) as
      Role | undefined;
    const reason = Reflect.getMetadata(NO_ROLE_REQUIRED, target) as
      string | undefined;
    if (minimum !== undefined) found.push({ kind: 'requires', minimum });
    if (reason !== undefined) found.push({ kind: 'none', reason });
  }
  if (found.length > 1) {
    return {
      ok: false,
      problem: 'has more than one role decorator (handler and controller)',
    };
  }
  return { ok: true, policy: found[0] ?? { kind: 'undeclared' } };
}

/** A one-line summary per route, for the role-listing tests and the startup error. */
export function describeRolePolicy(
  route: RegisteredRoute,
  requireDeclared: boolean,
): { line: string; problem: boolean } {
  const resolved = resolveRolePolicy(route.handler, route.controller);
  if (!resolved.ok) {
    return {
      line: `${route.route} (${route.name}): ${resolved.problem}`,
      problem: true,
    };
  }
  const p = resolved.policy;
  if (p.kind === 'requires')
    return { line: `${route.route}: role ${p.minimum}+`, problem: false };
  if (p.kind === 'none')
    return {
      line: `${route.route}: no role required (${p.reason})`,
      problem: false,
    };
  return requireDeclared
    ? {
        line: `${route.route} (${route.name}): has neither @RequiresRole nor @NoRoleRequired`,
        problem: true,
      }
    : { line: `${route.route}: any signed-in person`, problem: false };
}

export const ROLE_POLICY_REQUIRED = Symbol('ROLE_POLICY_REQUIRED');

/**
 * The global role guard (D1), installed by `ClerkAuthModule`:
 * - `@RequiresRole(minimum)` authenticates the caller (401 if not signed in) and answers 403
 *   `role_required` unless the token's role is at least `minimum`;
 * - `@NoRoleRequired(reason)` passes;
 * - an undeclared route passes where roles are optional (api-user: consent and the person's
 *   own session decide), and is refused with 500 where every route must declare one
 *   (api-admin; the application also refuses to start).
 */
@Injectable()
export class RoleGuard implements CanActivate {
  private readonly logger = new Logger(RoleGuard.name);

  constructor(
    private readonly people: PersonSessions,
    @Inject(ROLE_POLICY_REQUIRED) private readonly required: boolean,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const resolved = resolveRolePolicy(
      context.getHandler(),
      context.getClass(),
    );
    if (
      !resolved.ok ||
      (resolved.policy.kind === 'undeclared' && this.required)
    ) {
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} has no valid role policy`,
      );
      throw new InternalServerErrorException();
    }
    const { policy } = resolved;
    if (policy.kind !== 'requires') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const person = await this.people.authenticate(request);
    if (!isRole(person.role) || !hasRole(person.role, policy.minimum)) {
      throw new ForbiddenException({
        code: 'role_required',
        message: `This needs the ${policy.minimum} role or higher`,
        requiredRole: policy.minimum,
      });
    }
    return true;
  }
}
