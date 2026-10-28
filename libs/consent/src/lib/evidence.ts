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
 *   - v3 (D114, every event since the boxes became structured data): v2 plus the version's
 *     statements hash, so the words beside the box ticked are proven too (consent.evidenceVersion
 *     = 3);
 *   - v2 (D84, grants on the consent forms before D114): the form, its version and text hash,
 *     the DPA version and text hash, the statement, the event and the mechanism;
 *   - v1 (rows from before forms, and withdrawals of them): the DPA version and text hash, the
 *     type, the event and the mechanism.
 */
export function evidenceHash(e: EvidenceInput): string {
  const canonical = e.form?.statementsHash
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
