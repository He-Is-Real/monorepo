import { createHash } from 'node:crypto';
import type { RecordId, SurrealQueryable } from 'surrealdb';
import {
  DatabaseQueryError,
  isTransactionConflict,
  requireWritten,
  runQuery,
} from './query';

/**
 * `Idempotency-Key` handling (D29) on the `idempotencyKey` table:
 * id = `idempotencyKey:[<service>, <user record>, <key>]`.
 *
 * The key, the request hash and the stored response are written **in the same transaction as
 * the command**, in the caller's own session (a person may create and read their own api-user
 * keys). So either both commit or neither does: a retry after a lost response always replays,
 * and of two requests racing with one key exactly one commits (the other conflicts, looks the
 * key up again and replays, or gets `422` if its body differs).
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
 *
 * One bounded loop around the whole attempt: look the key up, then prepare (re-read,
 * re-check), then write command + key in one transaction. A retryable conflict, or losing the
 * key to a racing request, goes back to the **lookup** first (review round 2 of #41): if the
 * other request committed this key, its response is replayed, even when preparing again would
 * now refuse (e.g. a newer terms of use version was saved meanwhile).
 */
export async function runIdempotent(
  db: SurrealQueryable,
  scope: IdempotencyScope,
  hash: string,
  prepare: () => Promise<PreparedCommand>,
  {
    attempts = 4,
    backoffMs = 20,
  }: { attempts?: number; backoffMs?: number } = {},
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
      return { replayed: true, response: toResponse(stored) };
    }
    const command = await prepare();
    try {
      const results = await runQuery(
        db,
        `BEGIN TRANSACTION;
         ${command.statements}
         CREATE ${KEY} CONTENT {
           requestHash: $idem_hash, status: $idem_status,
           response: { id: $result.id, version: $result.version }
         } RETURN requestHash, status, response;
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
      return { replayed: false, response: toResponse(row) };
    } catch (err) {
      const retryable =
        isTransactionConflict(err) ||
        (err instanceof DatabaseQueryError && KEY_TAKEN.test(err.message));
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
}

function toResponse(row: StoredRow): IdempotentResponse {
  return {
    status: row.status,
    id: String(row.response?.id ?? ''),
    version: row.response?.version ?? null,
  };
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
