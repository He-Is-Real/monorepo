'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
  StaleVersion,
} from '@/lib/api-user';
import { forgetShareStorageExcept, PREFIX } from '@/lib/share-storage';
import {
  EMPTY_FIELDS,
  fieldsOf,
  mergePatch,
  normalise,
  plainMessage,
  sameField,
  type ShareApi,
  type ShareBeyondSite,
  type StoryFields,
  type StoryFormat,
} from './share-api';

/**
 * A written draft and its autosave (D29, D70, concern C8):
 *
 * - Every change is kept in this tab's sessionStorage at once, and stays there until the server
 *   has it: a reload, a crash or api-user being down never loses what the person wrote.
 * - The draft is created (`POST /v1/stories`, one Idempotency-Key kept across retries) once it
 *   has a title and some text: nothing is stored on the server before that.
 * - Then each pause in typing sends the changed fields as a merge patch with `If-Match`.
 * - A `412` (another tab, or a background write) re-reads the story and checks each field this
 *   tab changed: if the server's value is still what this tab last saw, or already what it has
 *   now, the change is re-applied on the new version without asking. Only when the same field
 *   changed elsewhere to something else does the person choose which to keep.
 */

export type SaveStatus =
  | 'idle' // nothing typed yet
  | 'unsaved' // kept on this device; no draft on the server yet (needs a title and text)
  | 'saving'
  | 'saved'
  | 'offline' // api-user couldn't be reached; kept on this device
  | 'conflict' // the same field changed in another tab
  | 'error' // refused (e.g. D94's draft limit); `error` says why
  | 'submitted'; // it has been submitted meanwhile (e.g. a submission whose answer was lost)

interface Stored {
  draftId: string | null;
  version: number | null;
  saved: StoryFields;
  local: StoryFields;
  createKey: string | null;
  /**
   * What the create with `createKey` sent, exactly. If its answer is lost, the retry sends the
   * same key and the same body, so api-user replays it (D29) and the draft's id is recovered;
   * what changed since then goes in a PATCH afterwards. Cleared once it's answered.
   */
  createSent: StoryFields | null;
  /** The story's format (video and audio, M2 plan PR 7); missing = written (older tabs). */
  format?: StoryFormat;
}

interface Conflict {
  /** The server's fields and version when the clash was found. */
  fields: StoryFields;
  version: number;
  /** The fields both sides changed differently: the person's choice applies to these only. */
  clashes: (keyof StoryFields)[];
}

export interface Draft {
  draftId: string | null;
  version: number | null;
  /** Written, video or audio: chosen at the start, or the loaded draft's. */
  format: StoryFormat;
  /** The format of a draft not created yet (Choose). */
  setFormat: (format: StoryFormat) => void;
  fields: StoryFields;
  status: SaveStatus;
  /**
   * The loaded story went for review before (sent back for changes, or withdrawn): submitting it
   * again doesn't count against the weekly limit (D94, D113).
   */
  submittedBefore: boolean;
  error: string | null;
  conflict: StoryFields | null;
  update: (change: Partial<StoryFields>) => void;
  /** Saves now; true when the server has everything on screen. */
  flush: () => Promise<boolean>;
  /**
   * Loads a draft from the server (resuming after a reload, or "Continue"). Answers whether it
   * can still be edited: `false` when it has been submitted meanwhile (e.g. a submission whose
   * answer was lost went through), and then nothing is kept for it.
   */
  load: (id: string) => Promise<boolean>;
  resolve: (keep: 'mine' | 'theirs') => Promise<void>;
  /** After submitting: forget the copy on this device. */
  forget: () => void;
  /** The story's new version after a command (submit) moved it. */
  setVersion: (version: number) => void;
  /** The draft's id and version now (after a save), not as of the last render. */
  current: () => { draftId: string | null; version: number | null };
  /**
   * The submission to send for this draft at `version` (D29): the unresolved one when there is
   * one for that version, else a new one, kept (in this tab's storage, per person and draft)
   * until it's settled. So a lost answer, then Back and Review again, or a reload, sends the
   * same key and the API replays what happened (Codex #118).
   */
  beginSubmit: (
    draftId: string,
    version: number,
    share?: ShareBeyondSite,
  ) => SubmitAttempt;
  /** The unresolved submission kept for this draft at `version`, if any (its body is fixed). */
  keptSubmit: (draftId: string, version: number) => SubmitAttempt | null;
  /** Forget the submission: it succeeded, or was definitely refused. Keep it when unknown. */
  settleSubmit: (draftId: string) => void;
}

/**
 * A submission being tried: its Idempotency-Key, the story version it was sent at and its body
 * (O4: sharing beyond heisreal.today, if ticked), all sent again as they were.
 */
export interface SubmitAttempt {
  key: string;
  draftId: string;
  version: number;
  share?: ShareBeyondSite;
}

/**
 * Keys are per signed-in person (their Clerk user id), so text one person left in a shared tab
 * is never shown to, or saved as, the next person who signs in there; starting the flow also
 * deletes anyone else's (forgetShareStorageExcept).
 */
const KEY = (owner: string, id: string | null) =>
  `${PREFIX}${owner}:${id ?? 'new'}`;
const SUBMIT_KEY = (owner: string, draftId: string) =>
  `${PREFIX}${owner}:submit:${draftId}`;

const DEBOUNCE_MS = 1200;

function readStored(owner: string, id: string | null): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(KEY(owner, id));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null; // storage blocked or garbled: nothing to restore
  }
}

function writeStored(owner: string, s: Stored) {
  try {
    window.sessionStorage.setItem(KEY(owner, s.draftId), JSON.stringify(s));
  } catch {
    // Storage blocked: the text still lives on screen and goes to the server.
  }
}

function removeStored(owner: string, id: string | null) {
  try {
    window.sessionStorage.removeItem(KEY(owner, id));
  } catch {
    // nothing to do
  }
}

/**
 * D70's three-way check: `base` is what this tab last saw from the server, `local` what it has
 * now, `server` what the server has. A field only this tab changed keeps this tab's value; a
 * field only the server changed takes the server's; the same field changed on both sides to
 * different values is a clash, for the person to settle.
 */
export function rebase(
  base: StoryFields,
  local: StoryFields,
  server: StoryFields,
): { clashes: (keyof StoryFields)[]; local: StoryFields } {
  const mine = normalise(local);
  const merged = { ...local };
  const clashes: (keyof StoryFields)[] = [];
  for (const k of Object.keys(server) as (keyof StoryFields)[]) {
    const changedHere = !sameField(mine, base, k);
    const changedThere = !sameField(server, base, k);
    if (!changedHere) (merged as Record<string, unknown>)[k] = server[k];
    else if (changedThere && !sameField(server, mine, k)) clashes.push(k);
  }
  return { clashes, local: merged };
}

/** The person's choice for the clashing fields only; every other field stays as merged. */
export function settle(
  local: StoryFields,
  server: StoryFields,
  clashes: (keyof StoryFields)[],
  keep: 'mine' | 'theirs',
): StoryFields {
  if (keep === 'mine') return local;
  const settled = { ...local };
  for (const k of clashes) (settled as Record<string, unknown>)[k] = server[k];
  return settled;
}

const dirty = (s: Stored) =>
  Object.keys(mergePatch(s.local, s.saved)).length > 0;
/** A written story needs its title and text; a video or audio story its title (D53). */
const canCreate = (f: StoryFields, format: StoryFormat = 'written') =>
  !!f.title.trim() && (format !== 'written' || !!f.body.trim());

/** `owner`: the signed-in person's Clerk user id. */
export function useDraft(api: ShareApi | null, owner: string): Draft {
  const state = useRef<Stored>({
    draftId: null,
    version: null,
    saved: EMPTY_FIELDS,
    local: EMPTY_FIELDS,
    createKey: null,
    createSent: null,
  });
  const [, render] = useState(0);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [submittedBefore, setSubmittedBefore] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const again = useRef(false);
  /**
   * False once this flow is gone (the page left, or another person signed in: the flow is keyed
   * by its owner). A save still on its way then stops where it is: no further request, and
   * nothing written to this tab's storage for a person who has left (Codex #118 round 4).
   */
  const alive = useRef(true);

  const commit = useCallback(
    (next: Stored) => {
      state.current = next;
      if (dirty(next) || !next.draftId) writeStored(owner, next);
      else removeStored(owner, next.draftId); // the server has it all
      render((n) => n + 1);
    },
    [owner],
  );

  // A new draft's text from before a reload, in this tab.
  useEffect(() => {
    forgetShareStorageExcept(owner);
    const stored = readStored(owner, null);
    if (stored && !state.current.draftId) {
      commit(stored);
      setStatus(canCreate(stored.local, stored.format) ? 'unsaved' : 'idle');
    }
  }, [commit, owner]);

  const saveOnce = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    for (let round = 0; round < 5; round++) {
      if (!alive.current) return false;
      const s = state.current;
      if (!s.draftId) {
        if (!canCreate(s.local, s.format)) {
          setStatus(
            s.local.title || s.local.body || s.local.description
              ? 'unsaved'
              : 'idle',
          );
          return false;
        }
        // One create per key, with exactly the body first sent under it (D29).
        const createKey = s.createKey ?? newIdempotencyKey();
        const sent =
          s.createKey && s.createSent ? s.createSent : normalise(s.local);
        commit({ ...s, createKey, createSent: sent });
        setStatus('saving');
        let created;
        try {
          created = await api.create(sent, createKey, s.format ?? 'written');
        } catch (err) {
          if (!alive.current) return false;
          // A definite refusal (e.g. the draft limit): the next try is a new create, with
          // whatever is on screen then. No answer, or a server error: keep both, to replay.
          if (err instanceof ApiUserProblem && err.status < 500) {
            commit({ ...state.current, createKey: null, createSent: null });
          }
          throw err;
        }
        // Gone meanwhile: the copy on this device (with the key and body) stays, so a later
        // visit by this person replays the create and recovers the draft.
        if (!alive.current) return false;
        removeStored(owner, null);
        commit({
          draftId: created.id,
          version: created.version,
          saved: sent,
          local: state.current.local,
          createKey: null,
          createSent: null,
          format: s.format,
        });
        continue;
      }
      // A draft's title or text can't be empty: while the person is clearing one to rewrite
      // it, keep it on this device rather than send a save the server would refuse.
      if (!canCreate(s.local, s.format)) {
        setStatus('unsaved');
        return false;
      }
      const patch = mergePatch(s.local, s.saved);
      if (!Object.keys(patch).length) {
        setStatus('saved');
        return true;
      }
      setStatus('saving');
      try {
        const sent = normalise(s.local);
        const { version } = await api.edit(s.draftId, s.version ?? 0, patch);
        if (!alive.current) return false;
        const saved = { ...state.current.saved };
        for (const k of Object.keys(patch) as (keyof StoryFields)[]) {
          (saved as Record<string, unknown>)[k] = sent[k];
        }
        commit({ ...state.current, version, saved });
      } catch (err) {
        if (!alive.current) return false;
        if (err instanceof ApiUserProblem && err.code === 'story_locked') {
          // Locked: it was submitted, e.g. by a submission whose answer was lost. If so,
          // there is nothing left to save here: say so (the flow shows "Thank you").
          const story = await api.story(s.draftId);
          if (!alive.current) return false;
          if (!['draft', 'changes_requested'].includes(story.status)) {
            removeStored(owner, s.draftId);
            try {
              window.sessionStorage.removeItem(SUBMIT_KEY(owner, s.draftId));
            } catch {
              // nothing to do
            }
            setStatus('submitted');
            return false;
          }
        }
        if (!(err instanceof StaleVersion)) throw err;
        // D70: re-read, and re-apply only what nobody else changed.
        const story = await api.story(s.draftId);
        if (!alive.current) return false;
        const server = fieldsOf(story);
        const { clashes, local } = rebase(s.saved, state.current.local, server);
        if (clashes.length) {
          // Keep what merged cleanly on screen; ask only about the clashing fields.
          commit({ ...state.current, local });
          setConflict({ fields: server, version: story.version, clashes });
          setStatus('conflict');
          return false;
        }
        commit({
          ...state.current,
          local,
          saved: server,
          version: story.version,
        });
      }
    }
    return !dirty(state.current);
  }, [api, commit, owner]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (conflict) return false;
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run = (async () => {
      let ok = false;
      do {
        again.current = false;
        try {
          ok = await saveOnce();
          setError(null);
        } catch (err) {
          ok = false;
          if (err instanceof ApiUserUnavailable) {
            setStatus('offline');
          } else {
            setStatus('error');
            setError(
              plainMessage(
                err,
                err instanceof ApiUserProblem && err.status === 403
                  ? 'Your consent is needed to save this story.'
                  : 'Your story couldn’t be saved. It’s kept on this device; try again.',
              ),
            );
          }
          return false;
        }
      } while (again.current && alive.current);
      return ok;
    })();
    running.current = run;
    try {
      return await run;
    } finally {
      running.current = null;
    }
  }, [conflict, saveOnce]);

  const update = useCallback(
    (change: Partial<StoryFields>) => {
      const s = state.current;
      commit({ ...s, local: { ...s.local, ...change } });
      if (status !== 'conflict') setStatus(s.draftId ? 'saving' : 'unsaved');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [commit, flush, status],
  );

  const load = useCallback(
    async (id: string): Promise<boolean> => {
      if (!api) return false;
      const story = await api.story(id);
      if (!alive.current) return false;
      if (!['draft', 'changes_requested'].includes(story.status)) {
        removeStored(owner, id);
        try {
          window.sessionStorage.removeItem(SUBMIT_KEY(owner, id));
        } catch {
          // nothing to do
        }
        return false;
      }
      setSubmittedBefore(!!story.submittedAt);
      const server = fieldsOf(story);
      const stored = readStored(owner, id);
      if (!stored) {
        commit({
          draftId: id,
          version: story.version,
          saved: server,
          local: server,
          createKey: null,
          createSent: null,
          format: story.primaryFormat,
        });
        setStatus('saved');
        return true;
      }
      // Text from before a reload: carry on from it, through the same check as a 412.
      commit({ ...stored, draftId: id, format: story.primaryFormat });
      if (stored.version !== story.version) {
        const { clashes, local } = rebase(stored.saved, stored.local, server);
        if (clashes.length) {
          commit({ ...state.current, local });
          setConflict({ fields: server, version: story.version, clashes });
          setStatus('conflict');
          return true;
        }
        commit({
          ...state.current,
          local,
          saved: server,
          version: story.version,
        });
      }
      setStatus(dirty(state.current) ? 'saving' : 'saved');
      if (dirty(state.current)) void flush();
      return true;
    },
    [api, commit, flush, owner],
  );

  const resolve = useCallback(
    async (keep: 'mine' | 'theirs') => {
      if (!conflict) return;
      const s = state.current;
      // D70, per field: the choice settles the clashing fields only. Everything else on screen
      // (this tab's other changes, and the other tab's that merged) stays and is saved.
      commit({
        ...s,
        local: settle(s.local, conflict.fields, conflict.clashes, keep),
        saved: conflict.fields,
        version: conflict.version,
      });
      setConflict(null);
      setStatus('saving');
      // The conflict guard in flush reads the old render's value: save directly.
      try {
        await saveOnce();
      } catch (err) {
        setStatus(err instanceof ApiUserUnavailable ? 'offline' : 'error');
      }
    },
    [commit, conflict, saveOnce],
  );

  const forget = useCallback(() => {
    removeStored(owner, state.current.draftId);
    removeStored(owner, null);
  }, [owner]);

  const keptSubmit = useCallback(
    (draftId: string, version: number): SubmitAttempt | null => {
      try {
        const kept = JSON.parse(
          window.sessionStorage.getItem(SUBMIT_KEY(owner, draftId)) ?? 'null',
        ) as SubmitAttempt | null;
        // The same draft at the same version: the same submission. A changed draft means the
        // earlier one can't have gone through (a submitted story can't be saved).
        return kept && kept.draftId === draftId && kept.version === version
          ? kept
          : null;
      } catch {
        return null; // unreadable: none
      }
    },
    [owner],
  );

  const beginSubmit = useCallback(
    (
      draftId: string,
      version: number,
      share?: ShareBeyondSite,
    ): SubmitAttempt => {
      const key = SUBMIT_KEY(owner, draftId);
      // A submission whose outcome is unknown is sent again exactly as it was.
      const kept = keptSubmit(draftId, version);
      if (kept) return kept;
      const attempt: SubmitAttempt = {
        key: newIdempotencyKey(),
        draftId,
        version,
        ...(share ? { share } : {}),
      };
      try {
        window.sessionStorage.setItem(key, JSON.stringify(attempt));
      } catch {
        // storage blocked: kept for this call only
      }
      return attempt;
    },
    [owner, keptSubmit],
  );

  const settleSubmit = useCallback(
    (draftId: string) => {
      try {
        window.sessionStorage.removeItem(SUBMIT_KEY(owner, draftId));
      } catch {
        // nothing to do
      }
    },
    [owner],
  );

  const setFormat = useCallback(
    (format: StoryFormat) => {
      if (!state.current.draftId) commit({ ...state.current, format });
    },
    [commit],
  );

  const setVersion = useCallback(
    (version: number) => commit({ ...state.current, version }),
    [commit],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return {
    draftId: state.current.draftId,
    version: state.current.version,
    format: state.current.format ?? 'written',
    setFormat,
    fields: state.current.local,
    status,
    submittedBefore,
    error,
    conflict: conflict?.fields ?? null,
    update,
    flush,
    load,
    resolve,
    forget,
    setVersion,
    beginSubmit,
    keptSubmit,
    settleSubmit,
    current: () => ({
      draftId: state.current.draftId,
      version: state.current.version,
    }),
  };
}
