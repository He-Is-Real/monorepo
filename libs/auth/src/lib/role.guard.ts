import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { hasRole, isRole, resolveRolePolicy } from '@heisreal/roles';
import type { Request } from 'express';
import { PersonSessions } from './person';
import type { RegisteredRoute } from './routes';

/** A one-line summary per route, for the role-listing tests and the startup error. */
export function describeRolePolicy(route: RegisteredRoute): {
  line: string;
  problem: boolean;
} {
  const resolved = resolveRolePolicy(route.handler, route.controller);
  if (!resolved.ok) {
    return {
      line: `${route.route} (${route.name}): ${resolved.problem}`,
      problem: true,
    };
  }
  const p = resolved.policy;
  return p.kind === 'requires'
    ? { line: `${route.route}: role ${p.minimum}+`, problem: false }
    : {
        line: `${route.route}: no role required (${p.reason})`,
        problem: false,
      };
}

/**
 * The global role guard (D1), installed by `ClerkAuthModule`:
 * - `@RequiresRole(minimum)` authenticates the caller (401 if not signed in) and answers 403
 *   `role_required` unless the token's role is at least `minimum`;
 * - `@NoRoleRequired(reason)` passes;
 * - a route with neither (or both) is refused with 500, and the application refuses to start
 *   (`ClerkAuthModule`). Fail closed in every service.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  private readonly logger = new Logger(RoleGuard.name);

  constructor(private readonly people: PersonSessions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const resolved = resolveRolePolicy(
      context.getHandler(),
      context.getClass(),
    );
    if (!resolved.ok) {
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
