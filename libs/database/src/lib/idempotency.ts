import { createHash } from 'node:crypto';
import type { RecordId, SurrealQueryable } from 'surrealdb';
import { requireWritten, runQuery } from './query';

/**
 * `Idempotency-Key` handling (D29) on the `idempotencyKey` table:
 * id = `idempotencyKey:[<service>, <user record>, <key>]`, kept 24 h (`expiresAt`).
 *
 * Only the services' own logins can use the table (a person session can't), so this runs on
 * the service connection, outside the command's own transaction. A crash between the command
 * and {@link IdempotencyStore.save} means a retry runs the command again: commands that use it
 * must tolerate that (an append to the consent ledger does: it re-affirms the same state).
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

const KEY = `type::record('idempotencyKey', [$service, $owner, $key])`;

interface StoredRow {
  requestHash: string;
  status: number;
  response?: { id?: string; version?: number };
  expired: boolean;
}

export class IdempotencyStore {
  constructor(private readonly db: SurrealQueryable) {}

  /**
   * Replays the stored response for this key, or runs `execute` and stores its response.
   * Throws {@link IdempotencyKeyReusedError} if the key was used with a different request.
   */
  async run(
    scope: IdempotencyScope,
    hash: string,
    execute: () => Promise<IdempotentResponse>,
  ): Promise<{ response: IdempotentResponse; replayed: boolean }> {
    const stored = await this.find(scope);
    if (stored && !stored.expired) {
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
    const response = await execute();
    await this.save(scope, hash, response, stored?.expired ?? false);
    return { response, replayed: false };
  }

  private async find(scope: IdempotencyScope): Promise<StoredRow | undefined> {
    const [row] = (await runQuery(
      this.db,
      `SELECT requestHash, status, response, expiresAt < time::now() AS expired FROM ${KEY}`,
      vars(scope),
    )) as [StoredRow[] | undefined];
    return row?.[0];
  }

  private async save(
    scope: IdempotencyScope,
    hash: string,
    response: IdempotentResponse,
    replaceExpired: boolean,
  ): Promise<void> {
    // expiresAt is set once (VALUE $before OR ...), so an expired row is replaced, not updated.
    const results = await runQuery(
      this.db,
      `BEGIN TRANSACTION;
       ${replaceExpired ? `DELETE ${KEY};` : ''}
       CREATE ${KEY} CONTENT {
         requestHash: $hash, status: $status,
         response: { id: <record> $id, version: $version }
       } RETURN requestHash;
       COMMIT TRANSACTION;`,
      {
        ...vars(scope),
        hash,
        status: response.status,
        id: response.id,
        version: response.version ?? undefined,
      },
    );
    requireWritten(results[results.length - 2], 'idempotency key');
  }
}

function vars(scope: IdempotencyScope) {
  return { service: scope.service, owner: scope.owner, key: scope.key };
}
