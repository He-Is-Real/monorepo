import { SetMetadata } from '@nestjs/common';
import { isRole, type Role } from './roles';

export const REQUIRES_ROLE = 'heisreal:requires-role';
export const NO_ROLE_REQUIRED = 'heisreal:no-role-required';

/**
 * The route needs the caller to hold `minimum` or a more privileged role (D1), read from the
 * verified session token's role claim. Must equal the operation's `x-required-role` in the
 * contract (each app's routes spec checks this against the OpenAPI).
 */
export function RequiresRole(minimum: Role): ClassDecorator & MethodDecorator {
  if (!isRole(minimum)) {
    throw new Error(`@RequiresRole: unknown role ${minimum}`);
  }
  return SetMetadata(REQUIRES_ROLE, minimum);
}

/**
 * The route deliberately has no minimum role (e.g. `/health`, signed webhooks); `reason` says
 * why. It's listed by each app's role-listing test.
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
  { kind: 'requires'; minimum: Role } | { kind: 'none'; reason: string };

export type RolePolicyResolution =
  { ok: true; policy: RolePolicy } | { ok: false; problem: string };

/**
 * A route's role policy: exactly one decorator, on the handler or its controller. None, or one
 * on each, is a misconfiguration: the guard refuses the request
 * and the application refuses to start.
 */
export function resolveRolePolicy(
  handler: object,
  controller: object,
): RolePolicyResolution {
  const found: RolePolicy[] = [];
  for (const target of [handler, controller]) {
    const minimum = Reflect.getMetadata(REQUIRES_ROLE, target) as
      Role | undefined;
    const reason = Reflect.getMetadata(NO_ROLE_REQUIRED, target) as
      string | undefined;
    if (minimum !== undefined) found.push({ kind: 'requires', minimum });
    if (reason !== undefined) found.push({ kind: 'none', reason });
  }
  if (found.length === 1) return { ok: true, policy: found[0] };
  return {
    ok: false,
    problem: found.length
      ? 'has more than one role decorator (handler and controller)'
      : 'has neither @RequiresRole nor @NoRoleRequired',
  };
}
