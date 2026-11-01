'use client';

import { createContext, useCallback, useEffect, useRef } from 'react';
import {
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
  StaleVersion,
} from '@/lib/api-user';
import type { AgreementName } from '@/lib/legal-text';
import { PREFIX } from '@/lib/share-storage';
import type { ShareApi, UploadRequest, UploadTarget } from './share-api';

/**
 * RequestUpload's idempotent request, shared by the video/audio panel (M2 plan PR 7) and the
 * picture panel (PR 10). A new upload's request (D29; Codex #133 round 1) is kept in this tab's
 * storage, with its Idempotency-Key and the version and body it was sent with, until its answer
 * settles it. Its answer can be lost after api-user put the file on the draft and counted it:
 * choosing the same file again then sends the very same request, and api-user replays it (the
 * same file, nothing new counted), however the draft's version moved on meanwhile. A `412` means
 * the draft changed elsewhere: it's read again (the same check as a save's), and the request is
 * made at its new version (a picture's request names the picture it replaces, so api-user refuses
 * it if another tab changed the picture meanwhile: Codex #140 round 3). A picture's request
 * (`keep`) is kept past its answer, until its PUT
 * succeeds or finds the file there (`forgetAttempt`): a PUT that failed or whose answer was lost
 * is retried by replaying it, which signs a fresh link for the same path and counts nothing new.
 */

/** A new upload's request, until its answer settles it. */
export interface Attempt {
  key: string;
  version: number;
  request: UploadRequest;
  name: string;
  size: number;
  lastModified: number;
}

/** A file as the panels know it again after a reload: its name, size and date. */
export interface FileId {
  name: string;
  size: number;
  lastModified: number;
}

/** Where a slot's request is kept (`upload-request` for video and audio, `image-request`). */
export type Slot = 'upload-request' | 'image-request';

const attemptKey = (owner: string, slot: Slot, draftId: string) =>
  `${PREFIX}${owner}:${slot}:${draftId}`;
export function readAttempt(
  owner: string,
  slot: Slot,
  draftId: string,
): Attempt | null {
  try {
    return JSON.parse(
      window.sessionStorage.getItem(attemptKey(owner, slot, draftId)) ?? 'null',
    ) as Attempt | null;
  } catch {
    return null;
  }
}
function writeAttempt(
  owner: string,
  slot: Slot,
  draftId: string,
  a: Attempt | null,
) {
  try {
    if (a) {
      window.sessionStorage.setItem(
        attemptKey(owner, slot, draftId),
        JSON.stringify(a),
      );
    } else window.sessionStorage.removeItem(attemptKey(owner, slot, draftId));
  } catch {
    // storage blocked: kept for this call only
  }
}

/** Settles a kept request: its upload is done, or the draft no longer has what it asked for. */
export function forgetAttempt(owner: string, slot: Slot, draftId: string) {
  writeAttempt(owner, slot, draftId, null);
}

/** No answer, or a server error: it may have gone through, so its request is kept to replay. */
export const outcomeUnknown = (err: unknown) =>
  err instanceof ApiUserUnavailable ||
  (err instanceof ApiUserProblem && err.status >= 500);

/**
 * The text api-user asks the person to agree to before it grants an upload (plan 4e: `403
 * terms_agreement_required` or `testimony_consent_required`), or null for any other answer.
 */
export function agreementFirst(err: unknown): AgreementName | null {
  if (!(err instanceof ApiUserProblem)) return null;
  if (err.code === 'terms_agreement_required') return 'terms-of-use';
  if (err.code === 'testimony_consent_required') return 'testimony-consent';
  return null;
}

/** What a panel says when the person didn't agree (yet): their file is still theirs to send. */
export function agreeFirstMessage(which: AgreementName, what: string): string {
  const text = which === 'terms-of-use' ? 'terms of use' : 'testimony consent';
  return `Your story is saved. To ${what}, please agree to the latest ${text}.`;
}

/**
 * Opens the share flow's agree-again screen (the same one a refused save opens: what changed since
 * the person's version, and its box) over the step, which stays as it was underneath. Answers
 * true once they agreed (the panel then asks for its upload again), false if they went back or
 * it couldn't be shown. Outside the share flow nothing is asked.
 */
export const AgreeAgain = createContext<
  (which: AgreementName) => Promise<boolean>
>(async () => false);

/**
 * How many times one upload asks before it stops asking and says why: the terms of use and then
 * the testimony consent can each be needed once.
 */
export const AGREE_ASKS = 2;

export const sameFile = (k: FileId | null, f: FileId) =>
  !!k &&
  k.name === f.name &&
  k.size === f.size &&
  k.lastModified === f.lastModified;

/**
 * Each run's token. Leaving the step (Back, another account) or a newer run makes an older run's
 * late answers unused: nothing kept, no upload started that nobody can see or cancel. `begin()`
 * starts a run and answers its `gone()`; `stop()` ends the current one.
 */
export function useRuns() {
  const runs = useRef(0);
  const begin = useCallback(() => {
    const mine = ++runs.current;
    return () => runs.current !== mine;
  }, []);
  const stop = useCallback(() => {
    runs.current++;
  }, []);
  useEffect(() => () => void runs.current++, []);
  return { begin, stop };
}

/**
 * A new upload for the file, once per request: a kept one for this file that `reuse` accepts and
 * that never got a settled answer is sent again as it was (its key, version and body), else a new
 * one. After a `412` the draft is read again and the request made once more at its version.
 * Answers null when the run was left behind or when `prepare` gave a reason (`onProblem`); else
 * the target and the request that made it (a replay's, which may differ from `request` where
 * `reuse` allows).
 */
export function useUploadRequest({
  calls,
  owner,
  slot,
  prepare,
  reload,
  setVersion,
  onProblem,
  reuse,
  keep = false,
}: {
  calls: ShareApi;
  owner: string;
  slot: Slot;
  prepare: () => Promise<{ draftId: string; version: number } | string>;
  reload: (draftId: string) => Promise<boolean>;
  setVersion: (version: number) => void;
  onProblem: (reason: string) => void;
  /** Whether a kept request may be sent again for this one. */
  reuse: (kept: Attempt, request: UploadRequest) => boolean;
  /** Keep the request past its answer, until the caller settles it (`forgetAttempt`). */
  keep?: boolean;
}) {
  return useCallback(
    async (
      file: FileId,
      first: { draftId: string; version: number },
      request: UploadRequest,
      gone: () => boolean,
    ): Promise<(UploadTarget & { sent: UploadRequest }) | null> => {
      // Left behind (Back, another account, a newer run): ask for nothing, keep nothing.
      if (gone()) return null;
      let ready = first;
      for (let again = false; ; again = true) {
        const kept = readAttempt(owner, slot, ready.draftId);
        const attempt: Attempt =
          kept && sameFile(kept, file) && reuse(kept, request)
            ? kept
            : {
                key: newIdempotencyKey(),
                version: ready.version,
                request,
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
              };
        writeAttempt(owner, slot, ready.draftId, attempt);
        try {
          const target = await calls.uploadUrl(
            ready.draftId,
            attempt.version,
            attempt.request,
            attempt.key,
          );
          if (gone()) return null;
          if (!keep) writeAttempt(owner, slot, ready.draftId, null);
          // A replay answers the version its request made; the draft may be past it since.
          if (target.version > ready.version) setVersion(target.version);
          return { ...target, sent: attempt.request };
        } catch (err) {
          if (outcomeUnknown(err) || gone()) throw err;
          writeAttempt(owner, slot, ready.draftId, null);
          if (!(err instanceof StaleVersion) || again) throw err;
          // Changed elsewhere (another tab, or a request of this one whose answer was lost):
          // read it again, then ask at its version.
          if (!(await reload(ready.draftId)) || gone()) throw err;
          const now = await prepare();
          if (gone()) return null;
          if (typeof now === 'string') {
            onProblem(now);
            return null;
          }
          ready = now;
        }
      }
    },
    [calls, owner, slot, prepare, reload, setVersion, onProblem, reuse, keep],
  );
}
