import { Injectable } from '@nestjs/common';
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
  ACCOUNT_CONSENT_TYPES,
  type AccountConsentType,
  type ConsentForm,
  type ConsentMechanism,
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
  /** O4: the story a sharing event is about (its id); `null` on every other event. */
  storyId: string | null;
  occurredAt: string;
}

export interface CurrentConsent {
  /** O4: the person's own consents; sharing beyond heisreal.today is per story (`StorySharing`). */
  type: AccountConsentType;
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

/**
 * O4: one story's sharing beyond heisreal.today, the contracts' `StorySharing`: its own latest
 * share_socials event (`fn::consent::story_sharing`).
 */
export interface StorySharing {
  /** The latest event for this story is a grant. */
  granted: boolean;
  /** Granted, and it counts (`fn::consent::valid`): on a social sharing version that counts. */
  counts: boolean;
  formVersion: string | null;
  occurredAt: string | null;
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
   * the terms of use version; each must be the one in force (409). Absent counts as not in
   * force (409): the server never binds a document the page didn't name.
   */
  privacyPolicyVersion?: string;
  termsVersion?: string;
  /**
   * O4: the story the person chooses sharing beyond heisreal.today for (its id): required with
   * `share_socials`, and only with it (the parser's 400; the database refuses it too).
   */
  storyId?: string;
}

/**
 * What WithdrawConsent withdraws: one of the person's own consents, or (O4) sharing beyond
 * heisreal.today for one story of theirs.
 */
export type WithdrawTarget =
  | Exclude<ConsentType, 'share_socials'>
  | { type: 'share_socials'; storyId: string };

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

/** O4: the story named isn't one of the person's own (`404`, as if it didn't exist). */
export class ConsentStoryNotFoundError extends Error {
  constructor() {
    super('No story of yours has that id');
    this.name = 'ConsentStoryNotFoundError';
  }
}

/** A story's `fn::consent::story_sharing` and `fn::consent::valid` of it, as `StorySharing`. */
export function storySharing(
  latest:
    | { event?: string; form?: string | null; occurredAt?: string }
    | null
    | undefined,
  valid: boolean | null | undefined,
): StorySharing {
  const granted = latest?.event === 'granted';
  return {
    granted,
    counts: granted && valid === true,
    formVersion: formRef(latest?.form)?.formVersion ?? null,
    occurredAt: latest?.occurredAt
      ? new Date(latest.occurredAt).toISOString()
      : null,
  };
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
  format: 'v1' | 'v2' | 'v3' | 'v4' | 'v5';
  verified: boolean;
}

interface RawEvent {
  id: string;
  type: string;
  event: 'granted' | 'withdrawn';
  dpaVersion: string;
  form?: string | null;
  story?: string | null;
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
  async state(person: SurrealQueryable): Promise<ConsentState> {
    const results = (await runQuery(
      person,
      `SELECT id, type, event, dpaVersion, form, story, mechanism, occurredAt FROM consent
         WHERE subject = $auth ORDER BY occurredAt ASC;
       RETURN $types.map(|$t| fn::consent::current($auth, $t));
       RETURN $types.map(|$t| fn::consent::valid(fn::consent::current($auth, $t)));
       RETURN fn::consent::signup_accepted($auth);
       RETURN fn::form::latest('signup').id;
       RETURN fn::consent::testimony_status($auth);`,
      { types: [...ACCOUNT_CONSENT_TYPES] },
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
      current: ACCOUNT_CONSENT_TYPES.map((type, i) => {
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
          storyId: e.story ? recordKey(e.story) : null,
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
         dpaVersion.contentHash AS dpaHash, form,
         form.textHash AS formHash, form.statementsHash AS statementsHash,
         termsVersion, termsVersion.contentHash AS termsHash, story
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
        termsVersion?: string | null;
        termsHash?: string | null;
        story?: string | null;
      }[],
    ];
    return found.map((r) => {
      const ref = formRef(r.form);
      const v5 = r.evidenceVersion === 5;
      const v4 = r.evidenceVersion === 4 || v5;
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
        // v4 (D125): the terms of use named, or none.
        ...(v4
          ? {
              terms: r.termsVersion
                ? {
                    version: recordKey(r.termsVersion),
                    contentHash: r.termsHash ?? 'missing',
                  }
                : null,
            }
          : {}),
        // v5 (O4): the story the sharing event is about.
        ...(v5 ? { story: r.story ? recordKey(r.story) : 'missing' } : {}),
        type: r.type,
        event: r.event,
        mechanism: r.mechanism,
      });
      return {
        id: recordKey(r.id),
        format: v5 ? 'v5' : v4 ? 'v4' : v3 ? 'v3' : ref ? 'v2' : 'v1',
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
   * O4: the statements that record a story's sharing beyond heisreal.today, for a command that
   * runs them in its own transaction (SubmitStory: Review's box is sent with the submission, so
   * the grant and the submission commit together or not at all). Checked as {@link grant} checks
   * it: the social sharing form and privacy policy shown must be the ones in force
   * (`ConsentConflictError`) and the story the person's own (`ConsentStoryNotFoundError`).
   * Recorded with `web_form_submission` and evidence v5. The statements bind `$event` and leave
   * `$result` to the caller, which merges `vars` into its own. The transaction's refusal (a
   * version replaced meanwhile) is {@link consentConflictOf}.
   */
  async storySharingGrant(
    person: SurrealQueryable,
    input: {
      formVersion: string;
      privacyPolicyVersion: string;
      storyId: string;
    },
  ): Promise<{ statements: string; vars: Record<string, unknown> }> {
    const prepared = await this.prepareGrant(person, {
      form: 'social',
      formVersion: input.formVersion,
      statement: 'share_socials',
      mechanism: 'web_form_submission',
      privacyPolicyVersion: input.privacyPolicyVersion,
      storyId: input.storyId,
    });
    return {
      statements: prepared.statements.replace(EVENT_RESULT, ''),
      vars: prepared.vars,
    };
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
   * Withdrawing Art 9 or account_data then erases the account (D39, D88, D73): the database
   * commits an erasure request with the withdrawal, and the HTTP endpoint runs the service's
   * erasure after this has committed (`ERASING_WITHDRAWALS`); housekeeping erases anyone missed.
   *
   * O4: sharing beyond heisreal.today is withdrawn per story (`{ type: 'share_socials', storyId }`),
   * following that story's own latest event; another story's choice is untouched. A story that
   * isn't the person's: `ConsentStoryNotFoundError`.
   */
  async withdraw(
    person: SurrealQueryable,
    target: WithdrawTarget,
    idempotency?: IdempotencyOptions,
  ): Promise<CommandOutcome> {
    return this.execute(person, idempotency, () =>
      this.prepareWithdraw(person, target),
    );
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
           dpaVersion: $d, dpaHash: $d.contentHash,
           termsVersion: $t, termsHash: $t.contentHash,
           mine: IF $story { array::len(SELECT VALUE id FROM type::record('story', $story)) = 1 }
             ELSE { NONE } }
       };`,
      { form: input.form, story: input.storyId ?? null },
    );
    const inForce = results[results.length - 1] as {
      id: string;
      textHash: string;
      statementsHash?: string | null;
      coversTerms: boolean;
      statements: string[];
      dpaVersion?: string | null;
      dpaHash?: string | null;
      termsVersion?: string | null;
      termsHash?: string | null;
      mine?: boolean | null;
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
    // O4: a story's sharing is its owner's to choose; anyone else's story reads as missing.
    if (input.storyId !== undefined && inForce.mine !== true) {
      throw new ConsentStoryNotFoundError();
    }
    if (!inForce.statementsHash) {
      // D114: the migration gives every version its statements data, so this is a bug or a
      // half-run migration: no consent without proof of the words beside the box.
      throw new Error(
        `${input.form} form ${input.formVersion} has no statements data (statementsHash)`,
      );
    }
    // D122: every grant binds the privacy policy in force (and on a sign-up version asking for
    // them, the terms of use in force); the page must name the ones it showed. A missing one is
    // refused like a stale one (a page from an older release reloads), never filled in here.
    const dpa = inForce.dpaVersion ? recordKey(inForce.dpaVersion) : null;
    const terms = inForce.termsVersion ? recordKey(inForce.termsVersion) : null;
    if (!dpa || !inForce.dpaHash || input.privacyPolicyVersion !== dpa) {
      throw new ConsentConflictError(
        'legal_document_not_in_force',
        dpa
          ? `Consent is given under the privacy policy in force (${dpa})`
          : 'No privacy policy is published yet, so consent can’t be given',
      );
    }
    if (
      inForce.coversTerms &&
      (!terms || !inForce.termsHash || input.termsVersion !== terms)
    ) {
      throw new ConsentConflictError(
        'legal_document_not_in_force',
        terms
          ? `The sign-up form binds the terms of use in force (${terms})`
          : 'No terms of use are published yet, so the sign-up form can’t be accepted',
      );
    }
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
        ${EVENT_RESULT}`,
      vars: {
        form_kind: input.form,
        type: input.statement,
        dpa,
        terms: inForce.coversTerms ? terms : null,
        form: `${FORM_TABLES[input.form]}:${input.formVersion}`,
        story: input.storyId ?? null,
        mechanism: input.mechanism,
        // O4: v5 binds the story too.
        evidence_version: input.storyId === undefined ? 4 : 5,
        hash: evidenceHash({
          form: {
            kind: input.form,
            version: input.formVersion,
            textHash: inForce.textHash,
            statementsHash: inForce.statementsHash,
          },
          dpaVersion: dpa,
          dpaContentHash: inForce.dpaHash,
          terms:
            inForce.coversTerms && terms
              ? { version: terms, contentHash: inForce.termsHash as string }
              : null,
          ...(input.storyId === undefined ? {} : { story: input.storyId }),
          type: input.statement,
          event: 'granted',
          mechanism: input.mechanism,
        }),
      },
    };
  }

  private async prepareWithdraw(
    person: SurrealQueryable,
    target: WithdrawTarget,
  ): Promise<PreparedCommand> {
    const type = typeof target === 'string' ? target : target.type;
    const story = typeof target === 'string' ? null : target.storyId;
    const results = await runQuery(
      person,
      `LET $latest = IF $story { fn::consent::story_sharing($auth, type::record('story', $story)) }
         ELSE { fn::consent::current($auth, $type) };
       RETURN { latest: $latest, contentHash: $latest.dpaVersion.contentHash,
         textHash: $latest.form.textHash, statementsHash: $latest.form.statementsHash,
         terms: $latest.termsVersion, termsHash: $latest.termsVersion.contentHash,
         mine: IF $story { array::len(SELECT VALUE id FROM type::record('story', $story)) = 1 }
           ELSE { NONE } };`,
      { type, story },
    );
    const {
      latest,
      contentHash,
      textHash,
      statementsHash,
      terms,
      termsHash,
      mine,
    } = results[results.length - 1] as {
      latest: RawSnapshot | null;
      contentHash: string | null;
      textHash: string | null;
      statementsHash?: string | null;
      terms?: string | null;
      termsHash?: string | null;
      mine?: boolean | null;
    };
    if (story !== null && mine !== true) throw new ConsentStoryNotFoundError();
    if (!latest || !contentHash) {
      throw new ConsentConflictError(
        'consent_not_granted',
        'This consent was never given, so there is nothing to withdraw',
      );
    }
    const dpa = recordKey(latest.dpaVersion);
    const ref = formRef(latest.form);
    // O4: a story's sharing grant always has its version's statements data (D114), which v5
    // needs; without it this is a bug, so nothing is recorded.
    if (story !== null && !(ref && statementsHash)) {
      throw new Error('The story’s sharing grant has no statements data');
    }
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
        ${EVENT_RESULT}`,
      vars: {
        type,
        dpa,
        // D122: a withdrawal binds the documents of the grant it follows.
        terms: terms ? recordKey(terms) : null,
        form: latest.form ?? null,
        story,
        mechanism,
        // D114, D125: v4 when the withdrawn grant's form version has statements data; O4: v5
        // for a story's sharing.
        evidence_version: story !== null ? 5 : ref && statementsHash ? 4 : null,
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
          ...(ref && statementsHash
            ? {
                terms: terms
                  ? {
                      version: recordKey(terms),
                      contentHash: termsHash ?? 'missing',
                    }
                  : null,
              }
            : {}),
          ...(story !== null ? { story } : {}),
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
      throw consentConflictOf(err) ?? err;
    }
  }
}

/** A ledger command's answer: the event it appended. */
const EVENT_RESULT = 'LET $result = { id: $event.id, version: NONE };';

/**
 * The database's refusal of a grant as the 409 it is (the backstop, D20, D84): the form version,
 * privacy policy or terms shown stopped being the ones in force between the check and the
 * commit. `undefined` for any other error.
 */
export function consentConflictOf(
  err: unknown,
): ConsentConflictError | undefined {
  if (
    err instanceof DatabaseQueryError &&
    (err.message.includes(PUBLISHED_FORM_REFUSED) ||
      err.message.includes(NOT_IN_FORCE))
  ) {
    return new ConsentConflictError(
      'form_version_not_in_force',
      'The form version, privacy policy or terms of use shown is no longer the one in force',
    );
  }
  return undefined;
}

/** Appends one ledger event as `$event`; fails the transaction if it wasn't written. */
function appendEvent(event: 'granted' | 'withdrawn'): string {
  return `LET $event = (CREATE ONLY consent CONTENT {
      subject: $auth, type: $type, event: '${event}',
      dpaVersion: type::record('dpaVersion', $dpa),
      termsVersion: IF $terms { type::record('termsVersion', $terms) } ELSE { NONE },
      form: IF $form { <record> $form } ELSE { NONE },
      story: IF $story { type::record('story', $story) } ELSE { NONE },
      mechanism: $mechanism, evidenceHash: $hash,
      evidenceVersion: IF $evidence_version { $evidence_version } ELSE { NONE }
    } RETURN id);
    IF $event = NONE { THROW 'the consent event was not written' };`;
}
