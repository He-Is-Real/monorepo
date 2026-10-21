import { SetMetadata } from '@nestjs/common';
import {
  type ConsentRequirement,
  CONSENT_TYPES,
  type ConsentType,
} from './consent.types';

export const REQUIRES_CONSENT = 'heisreal:requires-consent';
export const NO_CONSENT_REQUIRED = 'heisreal:no-consent-required';

/**
 * The route needs current consent (D21): the global ConsentGuard checks the ledger before the
 * handler runs and answers `403` otherwise. Prefer the named requirements in
 * `CONSENT_REQUIRED`. Mark the operation with `x-requires-consent` in the contract too.
 */
export function RequiresConsent(
  requirement: ConsentRequirement,
): ClassDecorator & MethodDecorator {
  if (!requirement.types.length) {
    throw new Error('@RequiresConsent needs at least one consent type');
  }
  const unknown = requirement.types.filter(
    (t) => !(CONSENT_TYPES as readonly ConsentType[]).includes(t),
  );
  if (unknown.length) {
    throw new Error(
      `@RequiresConsent: unknown consent type ${unknown.join(', ')}`,
    );
  }
  return SetMetadata(REQUIRES_CONSENT, {
    ...requirement,
    types: [...requirement.types],
  });
}

/**
 * The route deliberately needs no consent; `reason` says why (D21). It is recorded, listed by
 * the route-listing test and shown in review, so make it specific.
 */
export function NoConsentRequired(
  reason: string,
): ClassDecorator & MethodDecorator {
  if (reason.trim().length < 10) {
    throw new Error('@NoConsentRequired needs a real reason (10+ characters)');
  }
  return SetMetadata(NO_CONSENT_REQUIRED, reason.trim());
}

export type ConsentPolicy =
  | { kind: 'requires'; requirement: ConsentRequirement }
  | { kind: 'none'; reason: string };

export type PolicyResolution =
  { ok: true; policy: ConsentPolicy } | { ok: false; problem: string };

/**
 * A route's policy: exactly one decorator, on the handler or on its controller class. None,
 * or more than one (e.g. one on the class and another on the handler), is a misconfiguration:
 * the guard refuses the request and the application refuses to start.
 */
export function resolveConsentPolicy(
  handler: object,
  controller: object,
): PolicyResolution {
  const found: ConsentPolicy[] = [];
  for (const target of [handler, controller]) {
    const requirement = Reflect.getMetadata(REQUIRES_CONSENT, target) as
      ConsentRequirement | undefined;
    const reason = Reflect.getMetadata(NO_CONSENT_REQUIRED, target) as
      string | undefined;
    if (requirement) found.push({ kind: 'requires', requirement });
    if (reason !== undefined) found.push({ kind: 'none', reason });
  }
  if (found.length === 1) return { ok: true, policy: found[0] };
  return {
    ok: false,
    problem: found.length
      ? 'has more than one consent decorator (handler and controller)'
      : 'has neither @RequiresConsent nor @NoConsentRequired',
  };
}
