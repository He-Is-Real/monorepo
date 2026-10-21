import { createHash } from 'node:crypto';
import type { RecordId, SurrealQueryable } from 'surrealdb';
import {
  DatabaseQueryError,
  isTransactionConflict,
  requireWritten,
  retryOnConflict,
  runQuery,
} from './query';

/**
 * `Idempotency-Key` handling (D29) on the `idempotencyKey` table:
 * id = `idempotencyKey:[<service>, <user record>, <key>]`.
 *
 * The key, the request hash and the stored response are written **in the same transaction as
 * the command**, in the caller's own session (a person may create and read their own api-user
 * keys). So either both commit or neither does: a retry after a lost response always replays,
 * and of two requests racing with one key exactly one commits (the other conflicts on the key
 * record, re-reads it and replays, or gets `422` if its body differs).
 *
 * Keys are kept until pruned (24 h, `expiresAt`, by the nightly job; not built yet) and replay
 * until then.
 */
export type IdempotencyService = 'api-user' | 'api-admin';

export interface IdempotencyScope {
  service: IdempotencyService;
  /** The person's `user` record (`$auth` of their session), never the Clerk id. */
  owner: RecordId;
  /** The client's `Idempotency-Key` header. */
  key: string;
}

/** What a command answered; `id` is a record id string (`table:id`). */
export interface IdempotentResponse {
  status: number;
  id: string;
  version: number | null;
}

/**
 * A command to run inside the transaction. `statements` must end by setting
 * `LET $result = { id: <record>, version: <int | NONE> };` and must contain no `RETURN`,
 * `BEGIN` or `COMMIT` (docs/db-permissions.md, gotchas). Parameter names starting with
 * `idem_` are reserved.
 */
export interface PreparedCommand {
  statements: string;
  vars: Record<string, unknown>;
  /** HTTP status to store and replay (e.g. 201, 202). */
  status: number;
}

/** The same key was used before with a different request body (`422`). */
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request');
    this.name = 'IdempotencyKeyReusedError';
  }
}

/** sha256 of a canonical JSON form of the request (method, path and body). */
export function requestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const KEY = `type::record('idempotencyKey', [$idem_service, $idem_owner, $idem_key])`;

interface StoredRow {
  requestHash: string;
  status: number;
  response?: { id?: string; version?: number };
}

/** The key record already exists: another request with this key committed first. */
const KEY_TAKEN = /already exists/i;

/**
 * Runs `prepare()`'s command once per key. Replays the stored response for a known key with
 * the same request hash; throws {@link IdempotencyKeyReusedError} for a different one.
 * `prepare` runs only when the key is new, and again on every retry (re-read, re-check).
 */
export async function runIdempotent(
  db: SurrealQueryable,
  scope: IdempotencyScope,
  hash: string,
  prepare: () => Promise<PreparedCommand>,
): Promise<{ response: IdempotentResponse; replayed: boolean }> {
  const vars = {
    idem_service: scope.service,
    idem_owner: scope.owner,
    idem_key: scope.key,
  };
  for (let attempt = 1; ; attempt++) {
    const stored = await find(db, vars);
    if (stored) {
      if (stored.requestHash !== hash) throw new IdempotencyKeyReusedError();
      return {
        replayed: true,
        response: {
          status: stored.status,
          id: String(stored.response?.id ?? ''),
          version: stored.response?.version ?? null,
        },
      };
    }
    try {
      const response = await retryOnConflict(async () => {
        const command = await prepare();
        const results = await runQuery(
          db,
          `BEGIN TRANSACTION;
           ${command.statements}
           CREATE ${KEY} CONTENT {
             requestHash: $idem_hash, status: $idem_status,
             response: { id: $result.id, version: $result.version }
           } RETURN status, response;
           COMMIT TRANSACTION;`,
          {
            ...command.vars,
            ...vars,
            idem_hash: hash,
            idem_status: command.status,
          },
        );
        const row = requireWritten<StoredRow>(
          results[results.length - 2],
          'idempotency key',
        );
        return {
          status: row.status,
          id: String(row.response?.id ?? ''),
          version: row.response?.version ?? null,
        };
      });
      return { response, replayed: false };
    } catch (err) {
      // Lost the race for this key: what won is committed, so the next pass replays it (or
      // refuses a different body). A conflict that outlasted the retries is treated the same.
      const raced =
        (err instanceof DatabaseQueryError && KEY_TAKEN.test(err.message)) ||
        isTransactionConflict(err);
      if (!raced || attempt >= 3) throw err;
    }
  }
}

async function find(
  db: SurrealQueryable,
  vars: Record<string, unknown>,
): Promise<StoredRow | undefined> {
  const [row] = (await runQuery(
    db,
    `SELECT requestHash, status, response FROM ${KEY}`,
    vars,
  )) as [StoredRow[] | undefined];
  return row?.[0];
}
