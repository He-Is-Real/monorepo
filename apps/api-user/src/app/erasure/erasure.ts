import { Inject, Injectable } from '@nestjs/common';
import {
  ERASE_ACCOUNT,
  type ErasureReason,
  PENDING_DELETION_DONE,
  PENDING_DELETION_FAILED,
  PENDING_DELETIONS_DUE,
  type PendingDeletion,
  retryOnConflict,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import type { Surreal } from 'surrealdb';
import {
  BUNNY_STREAM,
  type BunnyStream,
} from '@heisreal/story-cards/bunny-stream';
import { CLERK_BACKEND, type ClerkBackend } from './clerk-backend';
import { note } from '@heisreal/logging/event';

interface FailedDeletion {
  kind: string;
  key: string;
  reason: string;
}

/**
 * Deletes a deleted story's whole folder from the images storage zone, every picture in it (an
 * `image` row is only ever queued by a story's delete). The images zone's client
 * (bunny-storage.ts); null with image uploads off, when `image` rows wait (logged).
 */
export interface ImageDeleter {
  deleteFolder(folder: string): Promise<void>;
}
export const IMAGE_DELETER = Symbol('IMAGE_DELETER');

/** How many other queued deletions, due for a retry, each erasure tries after its own. */
const RETRY_EARLIER = 10;

/**
 * EraseAccount (D39) for its two callers: "Delete my account" (also how a person withdraws all
 * consent, plan 4e) and Clerk's `user.deleted` webhook. The database half is one
 * transaction on api-user's own login (`ERASE_ACCOUNT`), retried until it commits; it leaves the
 * erased-identity tombstone (D82) and queues what must go elsewhere (D40). Then the queue is
 * drained at once: the person's Bunny videos and pictures, and their Clerk account (which ends
 * their sessions). Draining never fails the erasure: once the database half has committed, the
 * person is erased, and a deletion that fails (or a drain the database couldn't finish) stays
 * queued for the nightly housekeeping, which retries with backoff (pendingDeletion). Logged with
 * internal ids only (D40), for the restore runbook.
 */
@Injectable()
export class Erasure {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(BUNNY_STREAM) private readonly bunny: BunnyStream | null,
    @Inject(CLERK_BACKEND) private readonly clerk: ClerkBackend,
    @Inject(IMAGE_DELETER) private readonly images: ImageDeleter | null,
  ) {}

  async erase(clerkUserId: string, reason: ErasureReason): Promise<void> {
    const [user, pending] = await retryOnConflict(
      async () => {
        const results = await runQuery(this.db, ERASE_ACCOUNT, {
          clerkUserId,
          reason,
        });
        return results[results.length - 2] as [string | undefined, string[]];
      },
      { attempts: 8 },
    );
    if (user) {
      // The record backup recovery replays from (D40): on the request's event, or its own line
      // (same ref) if the caller already hung up and the event was written.
      note(
        {
          action: 'account.erase',
          erasure: {
            user_record: user,
            reason,
            queued_count: pending.length,
          },
        },
        { severity: 'INFO', message: 'Account erased' },
      );
    }
    const failed: FailedDeletion[] = [];
    try {
      if (pending.length > 0) await this.drain(pending, failed);
      await this.drain(undefined, failed);
    } catch (err) {
      // Housekeeping retries it.
      note(
        { erasure: { drain_failed: errorName(err) } },
        {
          severity: 'WARNING',
          message: 'Erased, but couldn’t work through the deletion queue',
        },
      );
    } finally {
      this.noteFailed(failed);
    }
  }

  /**
   * Works through queued deletions that are due: `keys` (those of one erasure), or else a few of
   * the others. Each row goes once its deletion is done, except a story folder's before its final
   * pass: a PUT link signed before the story went may still put a picture there, so the row waits
   * for housekeeping's last delete (fn::erasure::pending_done). A failure is pushed back
   * (fn::erasure::retry_after) and added to `failed`, which the caller logs once, after every pass
   * (so a later pass, or a database error, never loses an earlier pass's failures).
   */
  async drain(keys?: string[], failed: FailedDeletion[] = []): Promise<void> {
    const [rows] = (await runQuery(this.db, PENDING_DELETIONS_DUE, {
      kinds: ['bunny_video', 'image', 'clerk_user'],
      keys: keys ?? null,
      limit: keys ? keys.length : RETRY_EARLIER,
    })) as [PendingDeletion[]];
    for (const row of rows) {
      try {
        await this.delete(row);
      } catch (err) {
        // It stays queued.
        failed.push({ kind: row.kind, key: row.key, reason: errorName(err) });
        await runQuery(this.db, PENDING_DELETION_FAILED, { key: row.key });
        continue;
      }
      await runQuery(this.db, PENDING_DELETION_DONE, { key: row.key });
    }
  }

  private noteFailed(failed: FailedDeletion[]): void {
    if (!failed.length) return;
    note(
      { erasure: { deletions_failed: failed } },
      {
        severity: 'WARNING',
        message: 'Couldn’t delete queued deletions; they stay queued',
      },
    );
  }

  private async delete({ kind, ref }: PendingDeletion): Promise<void> {
    if (kind === 'bunny_video') {
      if (!this.bunny) throw new Error('Bunny Stream is off here');
      return this.bunny.deleteVideo(ref);
    }
    if (kind === 'image') {
      if (!this.images) throw new Error('the images zone is off here');
      return this.images.deleteFolder(ref);
    }
    return this.clerk.deleteUser(ref);
  }
}

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'error');
