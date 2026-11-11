/**
 * Roles (D1). Clerk `publicMetadata.role` is the source of truth, and the session token carries
 * it as the claim {@link ROLE_CLAIM} (`infra/clerk/dev.json`, `session.claims`). SurrealDB keeps
 * no authoritative role. This is the one definition in code. It must equal the `Role` enum in
 * `libs/contracts/openapi/components.yaml` (`roles.spec.ts` checks this). The order runs from
 * least to most privileged.
 */
export const ROLES = ['Viewer', 'User', 'Moderator', 'Admin'] as const;

export type Role = (typeof ROLES)[number];

/** The session-token claim that carries the role (Clerk "Customize session token"). */
export const ROLE_CLAIM = 'role';

/**
 * The role of a person without `publicMetadata.role`: every signed-in person is at least a
 * User. The session-token template supplies it (`{{user.public_metadata.role || 'User'}}`), so
 * the claim is never missing from a correctly configured token. A token without it is refused.
 */
export const DEFAULT_ROLE: Role = 'User';

export function isRole(value: unknown): value is Role {
  return (
    typeof value === 'string' && (ROLES as readonly string[]).includes(value)
  );
}

/** True if `role` is `minimum` or more privileged. */
export function hasRole(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum);
}

/** The only email domain staff may have (G7, Joel 2026-11-11). */
export const STAFF_EMAIL_DOMAIN = 'heisreal.today';

/**
 * The role a token's claims actually give (S-5 A, Joel 2026-11-11): a Moderator or Admin role
 * counts only with a verified `@heisreal.today` email in the same token; otherwise the person is
 * a User, so taking that email off an account ends their staff powers at the next token.
 * `verifiedEmail` is the token's email only when the token says it is verified, else undefined.
 */
export function effectiveRole(
  role: Role,
  verifiedEmail: string | undefined,
): Role {
  if (role !== 'Moderator' && role !== 'Admin') return role;
  const domain = verifiedEmail?.toLowerCase().split('@');
  return domain?.length === 2 &&
    domain[0] !== '' &&
    domain[1] === STAFF_EMAIL_DOMAIN
    ? role
    : DEFAULT_ROLE;
}
