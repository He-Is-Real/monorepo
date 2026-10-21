import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  DatabaseQueryError,
  requireWritten,
  retryOnConflict,
  runQuery,
} from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
import {
  type ConsentMechanism,
  CONSENT_TYPES,
  type ConsentType,
} from './consent.types';

/** One immutable ledger event, as the contracts' `ConsentRecord`. */
export interface ConsentEvent {
  id: string;
  /** A `ConsentType`, or a migrator-only type such as D44's legacy-migration (opaque here). */
  type: string;
  event: 'granted' | 'withdrawn';
  dpaVersion: string;
  mechanism: string;
  occurredAt: string;
}

export interface CurrentConsent {
  type: ConsentType;
  granted: boolean;
  dpaVersion: string | null;
  occurredAt: string | null;
  /** Granted, but a material DPA version newer than the one consented to is in force. */
  reconsentRequired: boolean;
}

/** The contracts' `ConsentState`. */
export interface ConsentState {
  current: CurrentConsent[];
  history: ConsentEvent[];
}

/** A published DPA version, as a person can read it. */
export interface PublishedDpa {
  id: string;
  kind: string;
  materiality: 'minor' | 'material';
  contentHash: string;
  effectiveFrom?: string | null;
  createdAt: string;
}

export interface GrantConsentInput {
  type: ConsentType;
  dpaVersion: string;
  mechanism: ConsentMechanism;
}

/** The command can't run in the ledger's current state (`409`). */
export class ConsentConflictError extends Error {
  constructor(
    readonly code: 'dpa_version_not_in_force' | 'consent_not_granted',
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

const orderKey = (d: PublishedDpa) =>
  Date.parse(d.effectiveFrom ?? d.createdAt);

/**
 * The DPA version in force: the newest published `standard` version whose `effectiveFrom`
 * has arrived (ordered by `effectiveFrom`, else `createdAt`). `undefined` while only drafts
 * exist (D20: v1 is a draft until legal sign-off), so no consent can be given yet.
 */
export function dpaInForce(
  published: readonly PublishedDpa[],
  now = Date.now(),
): PublishedDpa | undefined {
  return published
    .filter(
      (d) =>
        d.kind === 'standard' &&
        (!d.effectiveFrom || Date.parse(d.effectiveFrom) <= now),
    )
    .sort(
      (a, b) =>
        orderKey(b) - orderKey(a) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )[0];
}

/**
 * Whether a grant against `consented` needs re-consent: a material version newer than it is
 * now in force (gdpr-consent.md rule 5). A minor change is notify-only.
 */
export function reconsentRequired(
  consented: string,
  published: readonly PublishedDpa[],
  now = Date.now(),
): boolean {
  const inForce = dpaInForce(published, now);
  if (!inForce || inForce.id === consented) return false;
  const base = published.find((d) => d.id === consented);
  if (!base) return true; // consented to a version that's no longer offered
  return published.some(
    (d) =>
      d.kind === 'standard' &&
      d.materiality === 'material' &&
      orderKey(d) > orderKey(base) &&
      orderKey(d) <= orderKey(inForce),
  );
}

/**
 * The consent event's evidence hash (D19: instead of an IP address): sha256 of a canonical,
 * versioned description of what was presented and chosen. The DPA text is identified by its
 * own sha256 (`dpaVersion.contentHash`, computed from libs/legal/dpa/<id>.md), so the hash
 * can be recomputed later from the repo and the ledger alone.
 */
export function evidenceHash(e: {
  dpaVersion: string;
  dpaContentHash: string;
  type: string;
  event: 'granted' | 'withdrawn';
  mechanism: string;
}): string {
  const canonical = JSON.stringify([
    'heisreal-consent-evidence/v1',
    e.dpaVersion,
    e.dpaContentHash,
    e.type,
    e.event,
    e.mechanism,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const PUBLISHED_DPAS = `SELECT id, kind, materiality, contentHash, effectiveFrom, createdAt
  FROM dpaVersion WHERE status = 'published'`;

interface RawSnapshot {
  event: 'granted' | 'withdrawn';
  dpaVersion: string;
  occurredAt: string;
}

const PUBLISHED_DPA_REFUSED = 'published DPA version';

/**
 * The per-person consent ledger (D17–D20). Every method takes the **person's own session**
 * (D27): the database only shows them their own events, and only lets them append their own.
 * The ledger is append-only (enforced by the schema); "current" is always the latest event,
 * read through `fn::consent::current` (no cache, D18). No IP address is recorded (D19).
 */
@Injectable()
export class ConsentLedger {
  private readonly logger = new Logger(ConsentLedger.name);

  async state(
    person: SurrealQueryable,
    now = Date.now(),
  ): Promise<ConsentState> {
    const [history, latest, published] = (await runQuery(
      person,
      `SELECT id, type, event, dpaVersion, mechanism, occurredAt FROM consent
         WHERE subject = $auth ORDER BY occurredAt ASC;
       RETURN $types.map(|$t| fn::consent::current($auth, $t));
       ${PUBLISHED_DPAS};`,
      { types: [...CONSENT_TYPES] },
    )) as [ConsentEvent[], (RawSnapshot | null)[], PublishedDpa[]];
    const dpas = published.map(normaliseDpa);
    return {
      current: CONSENT_TYPES.map((type, i) => {
        const snap = latest[i] ?? null;
        const granted = snap?.event === 'granted';
        const dpa = snap ? recordKey(snap.dpaVersion) : null;
        return {
          type,
          granted,
          dpaVersion: dpa,
          occurredAt: snap?.occurredAt ?? null,
          reconsentRequired:
            granted && dpa !== null && reconsentRequired(dpa, dpas, now),
        };
      }),
      history: history.map((e) => ({
        ...e,
        id: recordKey(e.id),
        dpaVersion: recordKey(e.dpaVersion),
      })),
    };
  }

  /**
   * GrantConsent: appends one `granted` event against the DPA version in force. Refuses
   * (`ConsentConflictError`) any other version: a draft (D20; the database refuses it too), an
   * unknown one, or one that has been superseded. Returns the event's id.
   */
  async grant(
    person: SurrealQueryable,
    input: GrantConsentInput,
  ): Promise<string> {
    return retryOnConflict(async () => {
      const [published] = (await runQuery(person, PUBLISHED_DPAS)) as [
        PublishedDpa[],
      ];
      const dpa = dpaInForce(published.map(normaliseDpa));
      if (!dpa || dpa.id !== input.dpaVersion) {
        throw new ConsentConflictError(
          'dpa_version_not_in_force',
          dpa
            ? `Consent can only be given against the DPA version in force (${dpa.id})`
            : 'No DPA version is published yet, so consent can’t be given',
        );
      }
      const hash = evidenceHash({
        dpaVersion: dpa.id,
        dpaContentHash: dpa.contentHash,
        type: input.type,
        event: 'granted',
        mechanism: input.mechanism,
      });
      try {
        const [created] = await runQuery(
          person,
          `CREATE consent CONTENT {
             subject: $auth, type: $type, event: 'granted',
             dpaVersion: type::record('dpaVersion', $dpa),
             mechanism: $mechanism, evidenceHash: $hash
           } RETURN id`,
          { type: input.type, dpa: dpa.id, mechanism: input.mechanism, hash },
        );
        return recordKey(
          requireWritten<{ id: string }>(created, 'consent event').id,
        );
      } catch (err) {
        // The database is the backstop for D20 (e.g. a version unpublished in between: impossible
        // today, published versions are frozen, but never trusted to the application alone).
        if (
          err instanceof DatabaseQueryError &&
          err.message.includes(PUBLISHED_DPA_REFUSED)
        ) {
          throw new ConsentConflictError(
            'dpa_version_not_in_force',
            'The DPA version is not published',
          );
        }
        throw err;
      }
    });
  }

  /**
   * WithdrawConsent: appends a `withdrawn` event (bound to the version last granted) and, for
   * `publish` and `special_category_religious`, deletes the person's `publicStory` rows in the
   * same transaction (D17: every story follows the person's consent). Withdrawing again
   * re-affirms it. Never granted: `ConsentConflictError`.
   *
   * Not built here: withdrawing Art 9 also starts erasure (D39, M2). Until then the database's
   * consent gates stop all further processing of the person's stories, and they stay stored.
   */
  async withdraw(person: SurrealQueryable, type: ConsentType): Promise<string> {
    return retryOnConflict(async () => {
      const results = await runQuery(
        person,
        `LET $latest = fn::consent::current($auth, $type);
         RETURN { latest: $latest, contentHash: $latest.dpaVersion.contentHash };`,
        { type },
      );
      const { latest, contentHash } = results[results.length - 1] as {
        latest: RawSnapshot | null;
        contentHash: string | null;
      };
      if (!latest || !contentHash) {
        throw new ConsentConflictError(
          'consent_not_granted',
          'This consent was never given, so there is nothing to withdraw',
        );
      }
      const dpa = recordKey(latest.dpaVersion);
      const mechanism = 'account_settings';
      const hash = evidenceHash({
        dpaVersion: dpa,
        dpaContentHash: contentHash,
        type,
        event: 'withdrawn',
        mechanism,
      });
      const unpublish =
        type === 'publish' || type === 'special_category_religious';
      const tx = await runQuery(
        person,
        `BEGIN TRANSACTION;
         CREATE consent CONTENT {
           subject: $auth, type: $type, event: 'withdrawn',
           dpaVersion: type::record('dpaVersion', $dpa),
           mechanism: $mechanism, evidenceHash: $hash
         } RETURN id;
         ${
           unpublish
             ? `LET $stories = (SELECT VALUE id FROM story WHERE submitter = $auth);
                FOR $s IN $stories { DELETE type::record('publicStory', record::id($s)); };`
             : ''
         }
         COMMIT TRANSACTION;`,
        { type, dpa, mechanism, hash },
      );
      const id = recordKey(
        requireWritten<{ id: string }>(tx[1], 'consent withdrawal').id,
      );
      if (type === 'special_category_religious') {
        this.logger.warn(
          `Art 9 consent withdrawn (consent:${id}); erasure (D39) isn't built yet, so it wasn't started`,
        );
      }
      return id;
    });
  }
}

function normaliseDpa(d: PublishedDpa): PublishedDpa {
  return { ...d, id: recordKey(d.id) };
}
