import { Injectable, Logger } from '@nestjs/common';
import {
  DatabaseQueryError,
  type IdempotencyScope,
  type PreparedCommand,
  requireWritten,
  retryOnConflict,
  runIdempotent,
  runQuery,
} from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
import {
  type ConsentForm,
  type ConsentMechanism,
  CONSENT_TYPES,
  type ConsentType,
} from './consent.types';
import { evidenceHash } from './evidence';

/** A form version as the contracts name it: which form, and its version id. */
export interface FormRef {
  form: ConsentForm;
  formVersion: string;
}

/** One immutable ledger event, as the contracts' `ConsentRecord`. */
export interface ConsentEvent {
  id: string;
  /** A `ConsentType` (the statement ticked), or a migrator-only type (opaque here). */
  type: string;
  event: 'granted' | 'withdrawn';
  /** The form version the person saw (D84); `null` on rows from before forms (evidence v1). */
  form: ConsentForm | null;
  formVersion: string | null;
  dpaVersion: string;
  mechanism: string;
  occurredAt: string;
}

export interface CurrentConsent {
  type: ConsentType;
  /** The latest event is a grant. */
  granted: boolean;
  form: ConsentForm | null;
  formVersion: string | null;
  dpaVersion: string | null;
  occurredAt: string | null;
  /**
   * Granted, and it counts (`fn::consent::valid`): on a published or retired version that has
   * this statement. A newer version never stops a grant counting (D93).
   */
  counts: boolean;
}

/** D73: whether the person has accepted the sign-up form in force (sign-in waits for it). */
export interface SignupStatus {
  accepted: boolean;
  /** The sign-up version in force; `null` while none is published. */
  latestVersion: string | null;
}

/**
 * D85: the account's testimony version (the form of its current Art 9 grant) against the one in
 * force, for the signed-in banner ("a newer testimony form is out: update").
 */
export interface TestimonyStatus {
  version: string | null;
  latestVersion: string | null;
  /** A newer version is published that the person hasn't accepted. */
  updateAvailable: boolean;
  /**
   * D93: a version requiring acceptance for new submissions came after theirs: they must accept
   * the one in force before a new draft or submission. Their stories stay public.
   */
  acceptanceRequired: boolean;
}

/** The contracts' `ConsentState`. */
export interface ConsentState {
  current: CurrentConsent[];
  signup: SignupStatus;
  testimony: TestimonyStatus;
  history: ConsentEvent[];
}

export interface GrantConsentInput {
  /** Which form, and the version the person saw: it must be the one in force (409). */
  form: ConsentForm;
  formVersion: string;
  /** The statement (box) ticked: a consent type on that form version. */
  statement: ConsentType;
  mechanism: ConsentMechanism;
  /**
   * D122: the privacy policy version the page showed, and on a sign-up version asking for them
   * the terms of use version; each must be the one in force (409). Absent: the one in force.
   */
  privacyPolicyVersion?: string;
  termsVersion?: string;
}

/** An `Idempotency-Key` for one command (D29), scoped to the person. */
export interface IdempotencyOptions {
  scope: IdempotencyScope;
  requestHash: string;
}

/** What a ledger command did: the event's id, the status to answer, and whether it replayed. */
export interface CommandOutcome {
  id: string;
  status: number;
  replayed: boolean;
}

/** The command can't run in the ledger's current state (`409`). */
export class ConsentConflictError extends Error {
  constructor(
    readonly code:
      | 'form_version_not_in_force'
      | 'legal_document_not_in_force'
      | 'statement_not_on_form'
      | 'consent_not_granted',
    message: string,
  ) {
    super(message);
    this.name = 'ConsentConflictError';
  }
}

/** `table:id` → `id`: the contracts' IDs are opaque record keys without the table. */
export function recordKey(id: string): string {
  const key = id.slice(id.indexOf(':') + 1);
  return key.startsWith('⟨') && key.endsWith('⟩') ? key.slice(1, -1) : key;
}

const FORM_TABLES: Record<ConsentForm, string> = {
  signup: 'signupFormVersion',
  testimony: 'testimonyFormVersion',
  social: 'socialSharingFormVersion',
};

/** `testimonyFormVersion:v1` → `{ form: 'testimony', formVersion: 'v1' }`; `null` for none. */
export function formRef(id: string | null | undefined): FormRef | null {
  if (!id) return null;
  const table = id.slice(0, id.indexOf(':'));
  const form = (Object.keys(FORM_TABLES) as ConsentForm[]).find(
    (f) => FORM_TABLES[f] === table,
  );
  return form ? { form, formVersion: recordKey(id) } : null;
}

/** One ledger row checked against its recomputed evidence hash. */
export interface EvidenceCheck {
  id: string;
  format: 'v1' | 'v2' | 'v3' | 'v4';
  verified: boolean;
}

interface RawEvent {
  id: string;
  type: string;
  event: 'granted' | 'withdrawn';
  dpaVersion: string;
  form?: string | null;
  mechanism: string;
  occurredAt: string;
}

interface RawSnapshot {
  event: 'granted' | 'withdrawn';
  dpaVersion: string;
  form?: string | null;
  occurredAt: string;
}

/** The database refused a grant on a form version that isn't published (consent_form). */
const PUBLISHED_FORM_REFUSED = 'published form version';
/** The grant's own transaction found another version in force (prepareGrant). */
const NOT_IN_FORCE =
  'form_version_not_in_force: another version of the form is in force';

/**
 * The per-person consent ledger (D17–D20, D84). Every method takes the **person's own session**
 * (D27): the database only shows them their own events, and only lets them append their own.
 * The ledger is append-only (enforced by the schema); "current" is always the latest event,
 * read through `fn::consent::current` (no cache, D18). No IP address is recorded (D19).
 */
@Injectable()
export class ConsentLedger {
  private readonly logger = new Logger(ConsentLedger.name);

  async state(person: SurrealQueryable): Promise<ConsentState> {
    const results = (await runQuery(
      person,
      `SELECT id, type, event, dpaVersion, form, mechanism, occurredAt FROM consent
         WHERE subject = $auth ORDER BY occurredAt ASC;
       RETURN $types.map(|$t| fn::consent::current($auth, $t));
       RETURN $types.map(|$t| fn::consent::valid(fn::consent::current($auth, $t)));
       RETURN fn::consent::signup_accepted($auth);
       RETURN fn::form::latest('signup').id;
       RETURN fn::consent::testimony_status($auth);`,
      { types: [...CONSENT_TYPES] },
    )) as [
      RawEvent[],
      (RawSnapshot | null)[],
      boolean[],
      boolean,
      string | null,
      {
        version?: string | null;
        latest?: string | null;
        updateAvailable: boolean;
        acceptanceRequired: boolean;
      },
    ];
    const [history, latest, valid, accepted, signupLatest, testimony] = results;
    return {
      current: CONSENT_TYPES.map((type, i) => {
        const snap = latest[i] ?? null;
        const granted = snap?.event === 'granted';
        const ref = formRef(snap?.form);
        return {
          type,
          granted,
          form: ref?.form ?? null,
          formVersion: ref?.formVersion ?? null,
          dpaVersion: snap ? recordKey(snap.dpaVersion) : null,
          occurredAt: snap?.occurredAt ?? null,
          counts: granted && valid[i] === true,
        };
      }),
      signup: {
        accepted: accepted === true,
        latestVersion: signupLatest ? recordKey(signupLatest) : null,
      },
      testimony: {
        version: testimony.version ? recordKey(testimony.version) : null,
        latestVersion: testimony.latest ? recordKey(testimony.latest) : null,
        updateAvailable: testimony.updateAvailable === true,
        acceptanceRequired: testimony.acceptanceRequired === true,
      },
      history: history.map((e) => {
        const ref = formRef(e.form);
        return {
          id: recordKey(e.id),
          type: e.type,
          event: e.event,
          form: ref?.form ?? null,
          formVersion: ref?.formVersion ?? null,
          dpaVersion: recordKey(e.dpaVersion),
          mechanism: e.mechanism,
          occurredAt: e.occurredAt,
        };
      }),
    };
  }

  /**
   * Recomputes the evidence hash of every event in the person's ledger from the stored texts'
   * hashes (v1 and v2 rows alike), so the proof of what they agreed to can be checked.
   */
  async verifyEvidence(person: SurrealQueryable): Promise<EvidenceCheck[]> {
    const [found] = (await runQuery(
      person,
      `SELECT id, type, event, mechanism, evidenceHash, evidenceVersion, dpaVersion, occurredAt,
         dpaVersion.contentHash AS dpaHash, dpaVersion.pdfSha256 AS dpaPdf, form,
         form.textHash AS formHash, form.statementsHash AS statementsHash,
         termsVersion, termsVersion.textHash AS termsHash, termsVersion.pdfSha256 AS termsPdf
       FROM consent WHERE subject = $auth ORDER BY occurredAt ASC`,
    )) as [
      {
        id: string;
        type: string;
        event: 'granted' | 'withdrawn';
        mechanism: string;
        evidenceHash: string;
        dpaVersion: string;
        dpaHash: string;
        form?: string | null;
        formHash?: string | null;
        evidenceVersion?: number | null;
        statementsHash?: string | null;
        dpaPdf?: string | null;
        termsVersion?: string | null;
        termsHash?: string | null;
        termsPdf?: string | null;
      }[],
    ];
    return found.map((r) => {
      const ref = formRef(r.form);
      const v4 = r.evidenceVersion === 4;
      const v3 = r.evidenceVersion === 3 || v4;
      const expected = evidenceHash({
        form: ref
          ? {
              kind: ref.form,
              version: ref.formVersion,
              textHash: r.formHash ?? '',
              // v3 (D114): the statements data; a v3 row whose version has none can't verify.
              ...(v3 ? { statementsHash: r.statementsHash ?? 'missing' } : {}),
            }
          : undefined,
        dpaVersion: recordKey(r.dpaVersion),
        dpaContentHash: r.dpaHash,
        // v4 (D122): the documents' PDFs; a v4 row without them can't verify.
        ...(v4
          ? {
              dpaPdfSha256: r.dpaPdf ?? 'missing',
              ...(r.termsVersion
                ? {
                    terms: {
                      version: recordKey(r.termsVersion),
                      textHash: r.termsHash ?? 'missing',
                      pdfSha256: r.termsPdf ?? 'missing',
                    },
                  }
                : {}),
            }
          : {}),
        type: r.type,
        event: r.event,
        mechanism: r.mechanism,
      });
      return {
        id: recordKey(r.id),
        format: v4 ? 'v4' : v3 ? 'v3' : ref ? 'v2' : 'v1',
        verified: expected === r.evidenceHash,
      };
    });
  }

  /**
   * GrantConsent: appends one `granted` event for one statement, on the version of its form in
   * force (D84). Refuses (`ConsentConflictError`) any other version (a draft, retired, unknown or
   * older one: the database refuses all but published ones too) and a statement the version
   * doesn't have.
   *
   * With `idempotency`, the key and its response commit in the same transaction as the event
   * (D29), so a retry replays instead of granting again.
   */
  async grant(
    person: SurrealQueryable,
    input: GrantConsentInput,
    idempotency?: IdempotencyOptions,
  ): Promise<CommandOutcome> {
    return this.execute(person, idempotency, () =>
      this.prepareGrant(person, input),
    );
  }

  /**
   * WithdrawConsent: appends a `withdrawn` event (bound to the form version and DPA of the event
   * it follows) and, for `publish` and `special_category_religious`, deletes the person's
   * `publicStory` rows in the same transaction (D17: every story follows the person's consent).
   * Withdrawing `share_socials` stops sharing beyond heisreal.today (D93): nothing here is
   * unpublished or deleted. D107: within 30 days the media team removes the story from our own
   * channels and stops paid promotion (nothing posts yet, so there is nothing to automate).
   * Withdrawing again re-affirms it. Never granted: `ConsentConflictError`.
   *
   * Staged (review round 1): withdrawing Art 9 doesn't start erasure yet (D39, an M2
   * prerequisite), nor does withdrawing account_data delete the account (D73, D82). Until then
   * the database's consent gates stop all further processing, and the data stays stored.
   */
  async withdraw(
    person: SurrealQueryable,
    type: ConsentType,
    idempotency?: IdempotencyOptions,
  ): Promise<CommandOutcome> {
    const outcome = await this.execute(person, idempotency, () =>
      this.prepareWithdraw(person, type),
    );
    if (type === 'special_category_religious' && !outcome.replayed) {
      this.logger.warn(
        `Art 9 consent withdrawn (consent:${outcome.id}); erasure (D39) isn't built yet, so it wasn't started`,
      );
    }
    return outcome;
  }

  private async prepareGrant(
    person: SurrealQueryable,
    input: GrantConsentInput,
  ): Promise<PreparedCommand> {
    const results = await runQuery(
      person,
      `LET $f = fn::form::latest($form);
       LET $d = fn::legal::dpa_in_force();
       LET $t = IF $f.coversTerms = true { fn::legal::terms_in_force() } ELSE { NONE };
       RETURN IF $f = NONE { NONE } ELSE {
         { id: $f.id, textHash: $f.textHash, statementsHash: $f.statementsHash,
           coversTerms: $f.coversTerms = true, statements: fn::form::statements($f.id),
           dpaVersion: $d, dpaHash: $d.contentHash, dpaPdf: $d.pdfSha256,
           termsVersion: $t, termsHash: $t.textHash, termsPdf: $t.pdfSha256 }
       };`,
      { form: input.form },
    );
    const inForce = results[results.length - 1] as {
      id: string;
      textHash: string;
      statementsHash?: string | null;
      coversTerms: boolean;
      statements: string[];
      dpaVersion?: string | null;
      dpaHash?: string | null;
      dpaPdf?: string | null;
      termsVersion?: string | null;
      termsHash?: string | null;
      termsPdf?: string | null;
    } | null;
    if (!inForce || recordKey(inForce.id) !== input.formVersion) {
      throw new ConsentConflictError(
        'form_version_not_in_force',
        inForce
          ? `Consent is given on the ${input.form} form in force (${recordKey(inForce.id)})`
          : `No ${input.form} form is published yet, so consent can’t be given`,
      );
    }
    if (!inForce.statements.includes(input.statement)) {
      throw new ConsentConflictError(
        'statement_not_on_form',
        `The ${input.form} form ${input.formVersion} has no ${input.statement} statement`,
      );
    }
    if (!inForce.statementsHash) {
      // D114: the migration gives every version its statements data, so this is a bug or a
      // half-run migration: no consent without proof of the words beside the box.
      throw new Error(
        `${input.form} form ${input.formVersion} has no statements data (statementsHash)`,
      );
    }
    // D122: every grant binds the privacy policy in force (and on a sign-up version asking for
    // them, the terms of use in force); the page names the ones it showed.
    const dpa = inForce.dpaVersion ? recordKey(inForce.dpaVersion) : null;
    const terms = inForce.termsVersion ? recordKey(inForce.termsVersion) : null;
    if (
      !dpa ||
      !inForce.dpaHash ||
      (input.privacyPolicyVersion !== undefined &&
        input.privacyPolicyVersion !== dpa)
    ) {
      throw new ConsentConflictError(
        'legal_document_not_in_force',
        dpa
          ? `Consent is given under the privacy policy in force (${dpa})`
          : 'No privacy policy is published yet, so consent can’t be given',
      );
    }
    if (
      inForce.coversTerms &&
      (!terms ||
        !inForce.termsHash ||
        !inForce.termsPdf ||
        (input.termsVersion !== undefined && input.termsVersion !== terms))
    ) {
      throw new ConsentConflictError(
        'legal_document_not_in_force',
        terms
          ? `The sign-up form binds the terms of use in force (${terms})`
          : 'No terms of use are published yet, so the sign-up form can’t be accepted',
      );
    }
    const v4 = !!inForce.dpaPdf;
    return {
      status: 201,
      // Checked again in the transaction: a form version, privacy policy or terms published
      // since the check above must not let this grant commit (Codex, #101). The grant writes
      // legalFence (consent event), as does any of those publications, so they can't overlap.
      statements: `IF fn::form::latest($form_kind).id != <record> $form
          OR fn::legal::dpa_in_force() != type::record('dpaVersion', $dpa)
          OR ($terms AND fn::legal::terms_in_force() != type::record('termsVersion', $terms)) {
          THROW '${NOT_IN_FORCE}';
        };
        ${appendEvent('granted')}
        LET $result = { id: $event.id, version: NONE };`,
      vars: {
        form_kind: input.form,
        type: input.statement,
        dpa,
        terms: inForce.coversTerms ? terms : null,
        form: `${FORM_TABLES[input.form]}:${input.formVersion}`,
        mechanism: input.mechanism,
        evidence_version: v4 ? 4 : 3,
        hash: evidenceHash({
          form: {
            kind: input.form,
            version: input.formVersion,
            textHash: inForce.textHash,
            statementsHash: inForce.statementsHash,
          },
          dpaVersion: dpa,
          dpaContentHash: inForce.dpaHash,
          ...(v4
            ? {
                dpaPdfSha256: inForce.dpaPdf as string,
                ...(inForce.coversTerms && terms
                  ? {
                      terms: {
                        version: terms,
                        textHash: inForce.termsHash as string,
                        pdfSha256: inForce.termsPdf as string,
                      },
                    }
                  : {}),
              }
            : {}),
          type: input.statement,
          event: 'granted',
          mechanism: input.mechanism,
        }),
      },
    };
  }

  private async prepareWithdraw(
    person: SurrealQueryable,
    type: ConsentType,
  ): Promise<PreparedCommand> {
    const results = await runQuery(
      person,
      `LET $latest = fn::consent::current($auth, $type);
       RETURN { latest: $latest, contentHash: $latest.dpaVersion.contentHash,
         dpaPdf: $latest.dpaVersion.pdfSha256, textHash: $latest.form.textHash,
         statementsHash: $latest.form.statementsHash, terms: $latest.termsVersion,
         termsHash: $latest.termsVersion.textHash, termsPdf: $latest.termsVersion.pdfSha256 };`,
      { type },
    );
    const {
      latest,
      contentHash,
      dpaPdf,
      textHash,
      statementsHash,
      terms,
      termsHash,
      termsPdf,
    } = results[results.length - 1] as {
      latest: RawSnapshot | null;
      contentHash: string | null;
      textHash: string | null;
      statementsHash?: string | null;
      dpaPdf?: string | null;
      terms?: string | null;
      termsHash?: string | null;
      termsPdf?: string | null;
    };
    if (!latest || !contentHash) {
      throw new ConsentConflictError(
        'consent_not_granted',
        'This consent was never given, so there is nothing to withdraw',
      );
    }
    const dpa = recordKey(latest.dpaVersion);
    const ref = formRef(latest.form);
    const mechanism = 'account_settings';
    const unpublish =
      type === 'publish' || type === 'special_category_religious';
    return {
      status: 202,
      statements: `${appendEvent('withdrawn')}
        ${
          unpublish
            ? `LET $stories = (SELECT VALUE id FROM story WHERE submitter = $auth);
               FOR $s IN $stories { DELETE type::record('publicStory', record::id($s)); };`
            : ''
        }
        LET $result = { id: $event.id, version: NONE };`,
      vars: {
        type,
        dpa,
        // D122: a withdrawal binds the documents of the grant it follows.
        terms: terms ? recordKey(terms) : null,
        form: latest.form ?? null,
        mechanism,
        // D114: v3 when the withdrawn grant's form version has statements data; v4 (D122) when
        // its privacy policy also has a PDF of record.
        evidence_version: ref && statementsHash ? (dpaPdf ? 4 : 3) : null,
        hash: evidenceHash({
          form: ref
            ? {
                kind: ref.form,
                version: ref.formVersion,
                textHash: textHash ?? '',
                ...(statementsHash ? { statementsHash } : {}),
              }
            : undefined,
          dpaVersion: dpa,
          dpaContentHash: contentHash,
          ...(ref && statementsHash && dpaPdf
            ? {
                dpaPdfSha256: dpaPdf,
                ...(terms
                  ? {
                      terms: {
                        version: recordKey(terms),
                        textHash: termsHash ?? 'missing',
                        pdfSha256: termsPdf ?? 'missing',
                      },
                    }
                  : {}),
              }
            : {}),
          type,
          event: 'withdrawn',
          mechanism,
        }),
      },
    };
  }

  /** Runs a prepared command in one transaction, with or without an Idempotency-Key. */
  private async execute(
    person: SurrealQueryable,
    idempotency: IdempotencyOptions | undefined,
    prepare: () => Promise<PreparedCommand>,
  ): Promise<CommandOutcome> {
    try {
      if (idempotency) {
        const { response, replayed } = await runIdempotent(
          person,
          idempotency.scope,
          idempotency.requestHash,
          prepare,
        );
        return {
          id: recordKey(response.id),
          status: response.status,
          replayed,
        };
      }
      return await retryOnConflict(async () => {
        const command = await prepare();
        const results = await runQuery(
          person,
          `BEGIN TRANSACTION; ${command.statements} $result; COMMIT TRANSACTION;`,
          command.vars,
        );
        const result = requireWritten<{ id: string }>(
          results[results.length - 2],
          'consent event',
        );
        return {
          id: recordKey(result.id),
          status: command.status,
          replayed: false,
        };
      });
    } catch (err) {
      // The database is the backstop (D20, D84): e.g. the version retired in between.
      if (
        err instanceof DatabaseQueryError &&
        (err.message.includes(PUBLISHED_FORM_REFUSED) ||
          err.message.includes(NOT_IN_FORCE))
      ) {
        throw new ConsentConflictError(
          'form_version_not_in_force',
          'The form version, privacy policy or terms of use shown is no longer the one in force',
        );
      }
      throw err;
    }
  }
}

/** Appends one ledger event as `$event`; fails the transaction if it wasn't written. */
function appendEvent(event: 'granted' | 'withdrawn'): string {
  return `LET $event = (CREATE ONLY consent CONTENT {
      subject: $auth, type: $type, event: '${event}',
      dpaVersion: type::record('dpaVersion', $dpa),
      termsVersion: IF $terms { type::record('termsVersion', $terms) } ELSE { NONE },
      form: IF $form { <record> $form } ELSE { NONE },
      mechanism: $mechanism, evidenceHash: $hash,
      evidenceVersion: IF $evidence_version { $evidence_version } ELSE { NONE }
    } RETURN id);
    IF $event = NONE { THROW 'the consent event was not written' };`;
}
