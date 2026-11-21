import { HttpStatus } from '@nestjs/common';
import type { PersonSessions } from '@heisreal/auth';
import { hasRole, isRole } from '@heisreal/roles';
import type { Request, Response } from 'express';

/**
 * Whether api-admin refused a finished request for sign-in (RL-2, Joel 2026-11-21): what its
 * `staffRefused` limit counts. Yes for every `401` (not signed in, a refused or ended sign-in),
 * and for a `403` when the caller isn't staff: no `user` row yet (`unknown_person`), or a
 * signed-in person below Moderator (`role_required`).
 *
 * A `403` to a signed-in moderator is a normal answer (an Admin-only route or action, e.g.
 * approving anyway), not a refusal: decided by who the caller is, the sign-in the role guard
 * already verified for this request (cached, so nothing is verified twice), not by the body.
 */
export function signInRefusal(
  people: PersonSessions,
): (req: Request, res: Response) => boolean | Promise<boolean> {
  return (req, res) => {
    if (res.statusCode === HttpStatus.UNAUTHORIZED) return true;
    if (res.statusCode !== HttpStatus.FORBIDDEN) return false;
    return people.authenticate(req).then(
      (person) => !(isRole(person.role) && hasRole(person.role, 'Moderator')),
      () => true,
    );
  };
}
