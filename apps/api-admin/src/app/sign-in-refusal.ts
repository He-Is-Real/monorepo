import { HttpStatus } from '@nestjs/common';
import { bearerToken, type PersonSessions } from '@heisreal/auth';
import { hasRole, isRole } from '@heisreal/roles';
import type { Request, Response } from 'express';

/**
 * What api-admin's `staffRefused` limit counts (RL-2, Joel 2026-11-21): requests it refuses for
 * sign-in, never a signed-in moderator's or admin's (`RateLimits.refusals`).
 *
 * - On arrival: a request with no sign-in at all (no `Authorization: Bearer` token). Every
 *   api-admin route needs a role, so it will be `401`.
 * - When it ends: every `401` (a refused or ended sign-in), and a `403` to a caller who isn't
 *   staff: no `user` row yet (`unknown_person`), or signed in below Moderator (`role_required`).
 *   A caller who hangs up before the answer counts too, unless they're staff.
 *
 * A `403` to a signed-in moderator is a normal answer (an Admin-only route or action, e.g.
 * approving anyway), not a refusal: decided by who the caller is, the sign-in the role guard
 * already verified for this request (cached, so nothing is verified twice), not by the body.
 */
export function signInRefusal(people: PersonSessions) {
  const notStaff = (req: Request) =>
    people.authenticate(req).then(
      (person) => !(isRole(person.role) && hasRole(person.role, 'Moderator')),
      () => true,
    );
  return {
    refusedOnArrival: (req: Request): boolean => {
      try {
        bearerToken(req);
        return false;
      } catch {
        return true;
      }
    },
    isRefusal: (req: Request, res: Response): boolean | Promise<boolean> => {
      if (!res.writableFinished) return notStaff(req);
      if (res.statusCode === HttpStatus.UNAUTHORIZED) return true;
      if (res.statusCode !== HttpStatus.FORBIDDEN) return false;
      return notStaff(req);
    },
  };
}
