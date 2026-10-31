import { createHash } from 'node:crypto';

// No NestJS here: dev-seed imports this (@heisreal/consent/evidence) to give the fixture people
// the same evidence the API records.

/** What the evidence hash binds (D19: instead of an IP address). */
export interface EvidenceInput {
  /** The form version the person saw and its text's sha256 (D84); absent for evidence v1. */
  form?: {
    kind: 'signup' | 'testimony' | 'social';
    version: string;
    textHash: string;
    /**
     * D114: the sha256 of the version's statements file (the boxes and the words beside each);
     * present for evidence v3, absent for v2.
     */
    statementsHash?: string;
  };
  dpaVersion: string;
  dpaContentHash: string;
  /**
   * Evidence v4 (D125): set (null when the form version doesn't ask for them) on every event
   * with a form's statements data since; the terms of use version shown, with its words' sha256.
   */
  terms?: { version: string; contentHash: string } | null;
  /**
   * Evidence v5 (O4): the story a sharing event is about (its id, without the table), on every
   * event naming one; v4's fields plus this. Absent on every other event.
   */
  story?: string;
  /** The statement: a consent type. */
  type: string;
  event: 'granted' | 'withdrawn';
  mechanism: string;
}

/**
 * The consent event's evidence hash: sha256 of a canonical, versioned description of what was
 * presented and chosen. Every text is identified by its own sha256 (the form's `textHash`, the
 * DPA's `contentHash`, both computed from libs/legal), so the hash can be recomputed later from
 * the repo, or the copies in the database, and the ledger alone.
 *   - v5 (O4, every share_socials event since sharing became per story): v4 plus the story's id,
 *     so the ledger proves which story the person chose for (consent.evidenceVersion = 5);
 *   - v4 (D125, every event with statements data since): v3 plus, on a sign-up version asking
 *     for them, the terms of use version with its words' sha256 (null otherwise), so the ledger
 *     proves both documents in force (consent.evidenceVersion = 4);
 *   - v3 (D114, every event since the boxes became structured data): v2 plus the version's
 *     statements hash, so the words beside the box ticked are proven too (consent.evidenceVersion
 *     = 3);
 *   - v2 (D84, grants on the consent forms before D114): the form, its version and text hash,
 *     the DPA version and text hash, the statement, the event and the mechanism;
 *   - v1 (rows from before forms, and withdrawals of them): the DPA version and text hash, the
 *     type, the event and the mechanism.
 */
export function evidenceHash(e: EvidenceInput): string {
  const f = e.form;
  const v4 =
    f?.statementsHash && e.terms !== undefined
      ? [
          f.kind,
          f.version,
          f.textHash,
          f.statementsHash,
          e.dpaVersion,
          e.dpaContentHash,
          e.terms?.version ?? null,
          e.terms?.contentHash ?? null,
        ]
      : null;
  const canonical =
    v4 && e.story !== undefined
      ? [
          'heisreal-consent-evidence/v5',
          ...v4,
          e.story,
          e.type,
          e.event,
          e.mechanism,
        ]
      : v4
        ? ['heisreal-consent-evidence/v4', ...v4, e.type, e.event, e.mechanism]
        : e.form?.statementsHash
          ? [
              'heisreal-consent-evidence/v3',
              e.form.kind,
              e.form.version,
              e.form.textHash,
              e.form.statementsHash,
              e.dpaVersion,
              e.dpaContentHash,
              e.type,
              e.event,
              e.mechanism,
            ]
          : e.form
            ? [
                'heisreal-consent-evidence/v2',
                e.form.kind,
                e.form.version,
                e.form.textHash,
                e.dpaVersion,
                e.dpaContentHash,
                e.type,
                e.event,
                e.mechanism,
              ]
            : [
                'heisreal-consent-evidence/v1',
                e.dpaVersion,
                e.dpaContentHash,
                e.type,
                e.event,
                e.mechanism,
              ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
