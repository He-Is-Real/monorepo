import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ERASE_ACCOUNT,
  type ErasureReason,
  retryOnConflict,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import type { Surreal } from 'surrealdb';
import { BUNNY_STREAM, type BunnyStream } from '../stories/bunny-stream';
import { CLERK_BACKEND, type ClerkBackend } from './clerk-backend';

/**
 * Deletes one picture from the images storage zone, and its story's folder if that empties it
 * (media-runbook.md: an emptied folder stays otherwise). The seam for the images PR (M2 plan PR 10),
 * which adds the storage zone's client: until it provides this, nobody can upload a picture, so
 * erasure finds no image grants, and any `image` row would wait in the queue (logged).
 */
export interface ImageDeleter {
  deleteImage(path: string): Promise<void>;
}
export const IMAGE_DELETER = Symbol('IMAGE_DELETER');

/** How many earlier failures each erasure retries after its own deletions. */
const RETRY_EARLIER = 10;

interface Pending {
  key: string;
  kind: 'bunny_video' | 'image' | 'clerk_user';
  ref: string;
}

/**
 * EraseAccount (D39) for its three callers: "Delete my account", withdrawing the testimony (Art 9)
 * or sign-up consent (D88, D73), and Clerk's `user.deleted` webhook. The database half is one
 * transaction on api-user's own login (`ERASE_ACCOUNT`), retried until it commits; it leaves the
 * erased-identity tombstone (D82) and queues what must go elsewhere (D40). Then the queue is
 * drained at once: the person's Bunny videos and pictures, and their Clerk account (which ends
 * their sessions). A deletion that fails stays queued and is retried by the next erasure; a Bunny
 * video is also caught by the nightly housekeeping's orphan sweep, as no story or grant names it
 * any more. Logged with internal ids only (D40), for the restore runbook.
 */
@Injectable()
export class Erasure {
  private readonly logger = new Logger(Erasure.name);

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
      this.logger.log(
        `Erased ${user} (${reason}); ${pending.length} deletion(s) queued`,
      );
    }
    await this.drain(pending);
    await this.drain();
  }

  /**
   * Works through queued deletions: `keys` (those of one erasure), or else the oldest few. Each
   * row goes once its deletion is done; a failure is logged and stays for next time.
   */
  async drain(keys?: string[]): Promise<void> {
    if (keys && keys.length === 0) return;
    const [rows] = (await runQuery(
      this.db,
      keys
        ? `SELECT record::id(id) AS key, kind, ref, at FROM pendingDeletion
             WHERE record::id(id) IN $keys ORDER BY at`
        : `SELECT record::id(id) AS key, kind, ref, at FROM pendingDeletion
             ORDER BY at LIMIT $limit`,
      { keys, limit: RETRY_EARLIER },
    )) as [Pending[]];
    for (const row of rows) {
      try {
        await this.delete(row);
      } catch (err) {
        this.logger.warn(
          `Couldn’t delete queued ${row.kind} pendingDeletion:${row.key}; it stays queued: ${err instanceof Error ? err.message : 'error'}`,
        );
        continue;
      }
      await runQuery(this.db, `DELETE type::record('pendingDeletion', $key)`, {
        key: row.key,
      });
    }
  }

  private async delete({ kind, ref }: Pending): Promise<void> {
    if (kind === 'bunny_video') {
      if (!this.bunny) throw new Error('Bunny Stream is off here');
      return this.bunny.deleteVideo(ref);
    }
    if (kind === 'image') {
      if (!this.images) throw new Error('image deletion isn’t built yet');
      return this.images.deleteImage(ref);
    }
    return this.clerk.deleteUser(ref);
  }
}
