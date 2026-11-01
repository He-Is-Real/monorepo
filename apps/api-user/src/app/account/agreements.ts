import {
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { retryOnConflict, runQuery } from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';

/**
 * Plan 4e: what a person agrees to on their account (`AgreementName`), each a pointer on their
 * `user` row to a version of one legal text, with the database's time of agreeing.
 */
export const AGREEMENTS = {
  'terms-of-use': { pointer: 'termsOfUse', table: 'termsOfUseAgreement' },
  'testimony-consent': {
    pointer: 'testimonyConsent',
    table: 'testimonyConsent',
  },
} as const;
export type AgreementName = keyof typeof AGREEMENTS;
export const isAgreementName = (a: string): a is AgreementName =>
  Object.hasOwn(AGREEMENTS, a);

/** The contract's `Agreement`: a version someone agreed to, and when. */
export interface Agreement {
  version: number;
  agreedAt: string;
}

/** The contract's `AgreementState`. */
export interface AgreementState {
  agreed: Agreement | null;
  latestVersion: number;
  upToDate: boolean;
}

export interface Agreements {
  termsOfUse: AgreementState;
  testimonyConsent: AgreementState;
}

interface RawAgreements {
  terms?: number | null;
  termsAt?: string | null;
  termsLatest?: number | null;
  testimony?: number | null;
  testimonyAt?: string | null;
  testimonyLatest?: number | null;
}

/** The person's two pointers and the latest version of each text, read in their own session. */
const AGREEMENTS_SQL = `
  LET $u = (SELECT termsOfUse, termsOfUseAgreedAt, testimonyConsent, testimonyConsentAgreedAt
    FROM ONLY $auth);
  LET $tl = fn::legal::latest('termsOfUseAgreement');
  LET $cl = fn::legal::latest('testimonyConsent');
  RETURN {
    terms: IF $u.termsOfUse != NONE { record::id($u.termsOfUse) },
    termsAt: $u.termsOfUseAgreedAt,
    termsLatest: IF $tl != NONE { record::id($tl) },
    testimony: IF $u.testimonyConsent != NONE { record::id($u.testimonyConsent) },
    testimonyAt: $u.testimonyConsentAgreedAt,
    testimonyLatest: IF $cl != NONE { record::id($cl) }
  };`;

/** An `Agreement` from a pointer's version and time, or null for none. */
export function agreementOf(
  version: number | null | undefined,
  at: string | null | undefined,
): Agreement | null {
  return typeof version === 'number' && at
    ? { version, agreedAt: new Date(at).toISOString() }
    : null;
}

function stateOf(
  version: number | null | undefined,
  at: string | null | undefined,
  latest: number | null | undefined,
): AgreementState {
  // Every environment has version 0 of each text (data/0009); fail closed without one.
  if (typeof latest !== 'number') {
    throw new Error('A legal text has no version to agree to');
  }
  const agreed = agreementOf(version, at);
  return {
    agreed,
    latestVersion: latest,
    upToDate: agreed?.version === latest,
  };
}

/** Where the person stands with the terms of use and the testimony consent (`Account`). */
export async function readAgreements(
  person: SurrealQueryable,
): Promise<Agreements> {
  const r = (await runQuery(person, AGREEMENTS_SQL)).at(-1) as RawAgreements;
  return {
    termsOfUse: stateOf(r.terms, r.termsAt, r.termsLatest),
    testimonyConsent: stateOf(r.testimony, r.testimonyAt, r.testimonyLatest),
  };
}

/**
 * Command `Agree`, in the person's own session: points their `user` row at `version` of the
 * text, with the database's time. Only the latest version can be agreed to (the database's own
 * rule too, fn::legal::check_pointer): an older one is `409 agreement_version_changed`, so the
 * page fetches the latest and shows what changed. Agreeing to the version already agreed
 * changes nothing (a second write would move the time). Answers the new `AgreementState`.
 */
export async function agree(
  person: SurrealQueryable,
  name: AgreementName,
  version: number,
): Promise<AgreementState> {
  const { pointer, table } = AGREEMENTS[name];
  try {
    await retryOnConflict(() =>
      runQuery(
        person,
        `BEGIN TRANSACTION;
         LET $v = type::record($table, $version);
         IF $v != fn::legal::latest($table) {
           THROW 'agreement_version_changed: a newer version was saved since the page showed this one';
         };
         IF (SELECT VALUE ${pointer} FROM ONLY $auth) != $v {
           UPDATE $auth SET ${pointer} = $v, ${pointer}AgreedAt = time::now() RETURN NONE;
         };
         COMMIT TRANSACTION;`,
        { table, version },
      ),
    );
  } catch (err) {
    throw agreementRefusalOf(err) ?? err;
  }
  const state = await readAgreements(person);
  return name === 'terms-of-use' ? state.termsOfUse : state.testimonyConsent;
}

/**
 * "Agree first" (plan 4e; Joel, 2026-11-01): the database's refusals of a person's write until
 * they agree to the latest terms of use or testimony consent, and of an agreement on a version
 * that isn't the latest any more, as the contract's problems. `undefined` for anything else.
 */
export function agreementRefusalOf(err: unknown): HttpException | undefined {
  if (err instanceof HttpException) return undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (/\bterms_agreement_required:/.test(message)) {
    return new ForbiddenException({
      code: 'terms_agreement_required',
      message: 'Please agree to the latest terms of use first',
    });
  }
  if (/\btestimony_consent_required:/.test(message)) {
    return new ForbiddenException({
      code: 'testimony_consent_required',
      message: 'Please agree to the latest testimony consent first',
    });
  }
  if (/\bagreement_version_changed:/.test(message)) {
    return new ConflictException({
      code: 'agreement_version_changed',
      message:
        'A newer version was saved since this page showed it: read what changed, then agree again',
    });
  }
  return undefined;
}
