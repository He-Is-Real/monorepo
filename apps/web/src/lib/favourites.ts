'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ApiUserProblem, NotSignedIn } from '@/lib/api-user';
import {
  onPersonalSession,
  type PersonalSession,
  personalApiUser,
  personalSession,
  usePersonalSession,
} from '@/lib/personal-session';
import {
  SIGN_UP_CONSENT_PATH,
  withReturn,
} from '@/components/consent/consent-prompts';
import {
  hasDeviceHeart,
  onDeviceHearts,
  setDeviceHeart,
} from '@/lib/device-hearts';

/**
 * The person's hearts on this page (M2), in the browser only (D83): web's server renders every
 * card the same for everyone, then each heart asks here. Hearts are private (founder,
 * 2026-10-25): the person sees their own heart, no counts.
 *
 * - **One request colours a page of cards:** the hearts that mount together are asked about in
 *   one `GET /v1/account/favourites?storyId=…` (at most 50 ids each), once someone is signed in.
 *   Cards that arrive later ("Show more") ask for theirs.
 * - **Pressing a heart** changes it at once, then `PUT`s or `DELETE`s it, one command per story
 *   at a time so the last press wins on the server too; if that fails it goes back and says so.
 * - **Signed out** (or until the browser knows), hearts are this device's own
 *   (device-hearts.ts; Joel, 2026-10-28): pressing one saves it in this browser only, and nothing
 *   reaches our servers.
 * - **Signed in without the sign-up consent** (D73, "store my account and favourites"), api-user
 *   answers 403 `consent_required`: the heart is kept on the device and the person goes to the
 *   sign-up consent step, coming back here. Afterwards, the prompt offers to add the device's
 *   hearts to the account (device-hearts-prompt.tsx). Nothing is ever added without asking.
 * - **One person's hearts only:** everything here belongs to the person signed in now. An answer
 *   that arrives after someone else signed in (or out) is dropped (`generation`).
 */

const MAX_IDS_PER_LOOKUP = 50;

/** `unknown` while the browser doesn't know yet (hydrating, or the account's answer is on its way). */
export type HeartState = 'unknown' | 'on' | 'off';

let hearts = new Map<string, boolean>();
/** Every story id with a heart on this page, and how many hearts it has (cards, story page). */
const onPage = new Map<string, number>();
/** Ids on this page whose state isn't known yet (and isn't being asked for). */
let wanted = new Set<string>();
let owner: string | null = null; // whose hearts `hearts` holds
/** +1 whenever `owner` changes: async work started for one person never touches another's. */
let generation = 0;
let lookupScheduled = false;
let failed: string | null = null; // the story whose last change failed, for its message
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const client = personalApiUser;

/** A different person (or nobody) now: forget the last person's hearts. */
function follow(session: PersonalSession) {
  const who = session.status === 'signed-in' ? session.userId : null;
  if (who === owner) return;
  owner = who;
  generation += 1;
  failed = null;
  sending = new Map(); // the last person's commands settle on their own
  // Ask again about every heart on the page, including any whose answer is still on its way.
  wanted = new Set(onPage.keys());
  hearts = new Map();
  changed();
  if (session.status === 'signed-in') scheduleLookup();
}
if (typeof window !== 'undefined') {
  onPersonalSession(() => follow(personalSession()));
  onDeviceHearts(changed);
}

function scheduleLookup() {
  if (lookupScheduled) return;
  lookupScheduled = true;
  // After every heart of this render has registered: one request for all of them.
  setTimeout(() => {
    lookupScheduled = false;
    void lookup();
  }, 0);
}

async function lookup() {
  const session = personalSession();
  if (session.status !== 'signed-in' || wanted.size === 0) return;
  const ids = [...wanted];
  const mine = generation;
  wanted = new Set();
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_LOOKUP) {
    const chunk = ids.slice(i, i + MAX_IDS_PER_LOOKUP);
    const query = chunk.map((id) => `storyId=${encodeURIComponent(id)}`);
    try {
      const { data } = await client(session).get<{ data: { id: string }[] }>(
        `/v1/account/favourites?${query.join('&')}`,
      );
      if (generation !== mine) return; // someone else signed in (or out) meanwhile
      const on = new Set((data?.data ?? []).map((s) => s.id));
      for (const id of chunk) if (!hearts.has(id)) hearts.set(id, on.has(id));
    } catch {
      // Unknown stays unknown (an empty heart); pressing it still works.
      continue;
    }
    changed();
  }
}

function register(id: string): () => void {
  onPage.set(id, (onPage.get(id) ?? 0) + 1);
  const unregister = () => {
    const n = (onPage.get(id) ?? 1) - 1;
    if (n > 0) onPage.set(id, n);
    else onPage.delete(id);
  };
  follow(personalSession());
  if (hearts.has(id) || wanted.has(id)) return unregister;
  wanted.add(id);
  if (personalSession().status === 'signed-in') scheduleLookup();
  return unregister;
}

/**
 * To the sign-up consent step, coming back to this page. The heart is kept on the device, for
 * the prompt to offer once the step is done.
 */
function toSignupConsent(storyId: string) {
  setDeviceHeart(storyId, true);
  // The step (#116) returns to `redirect_url` once both boxes are ticked.
  window.location.assign(
    withReturn(
      SIGN_UP_CONSENT_PATH,
      `${window.location.pathname}${window.location.search}`,
    ),
  );
}

/**
 * Per story, while a command for it is on its way: the state the person wants now (Codex, #117
 * round 2). One command per story at a time, so a quick second press can't overtake the first
 * at the server; when one settles, the latest wanted state is sent if it differs.
 */
type Outcome = 'saved' | 'gone' | 'failed';
let sending = new Map<
  string,
  { want: boolean; settled: Promise<Outcome> | null }
>();

/**
 * Puts a heart on or takes it off, showing it at once. Commands for one story go one at a time,
 * and the last press wins, on the server too. On failure the heart goes back to what the server
 * last confirmed.
 */
async function setHeart(
  session: Extract<PersonalSession, { status: 'signed-in' }>,
  storyId: string,
  on: boolean,
): Promise<Outcome> {
  const mine = generation;
  let confirmed = hearts.get(storyId); // the server's state, as far as we know
  hearts.set(storyId, on);
  wanted.delete(storyId);
  if (failed === storyId) failed = null;
  changed();
  const busy = sending.get(storyId);
  if (busy?.settled) {
    busy.want = on; // sent once the command on its way settles
    return busy.settled; // how that ends (Codex, #117 round 4: never "saved" too early)
  }
  const slot: { want: boolean; settled: Promise<Outcome> | null } = {
    want: on,
    settled: null,
  };
  const queue = sending;
  queue.set(storyId, slot);
  slot.settled = send();
  return slot.settled;

  async function send(): Promise<Outcome> {
    let sent = on;
    try {
      for (;;) {
        await client(session).command(
          `/v1/account/favourites/${encodeURIComponent(storyId)}`,
          { method: sent ? 'PUT' : 'DELETE' },
        );
        if (generation !== mine) return 'failed'; // someone else's page now
        confirmed = sent;
        if (slot.want === sent) return 'saved';
        sent = slot.want;
      }
    } catch (err) {
      if (generation !== mine) return 'failed'; // someone else's page now: not theirs to change
      if (err instanceof ApiUserProblem && err.code === 'consent_required') {
        // What the person wants now (Codex, #117 round 3): taken off meanwhile, it stays off and
        // nothing is kept or asked. Only from a press, never replayed on load, so the consent
        // step can't loop.
        const stillWanted = slot.want;
        hearts.set(storyId, confirmed ?? false);
        changed();
        if (stillWanted) toSignupConsent(storyId);
        return 'failed';
      }
      if (err instanceof ApiUserProblem && err.status === 404) {
        // The story isn't public any more: nothing to heart.
        hearts.set(storyId, false);
        changed();
        return 'gone';
      } else if (err instanceof NotSignedIn) {
        hearts.set(storyId, confirmed ?? false);
      } else {
        if (confirmed === undefined) hearts.delete(storyId);
        else hearts.set(storyId, confirmed);
        failed = storyId;
      }
      changed();
      return 'failed';
    } finally {
      if (queue.get(storyId) === slot) {
        queue.delete(storyId);
        changed(); // no longer busy
      }
    }
  }
}

/** A heart pressed: the account's when signed in, otherwise this device's. */
function press(storyId: string) {
  const session = personalSession();
  if (session.status !== 'signed-in') {
    setDeviceHeart(storyId, !hasDeviceHeart(storyId));
    return;
  }
  void setHeart(session, storyId, hearts.get(storyId) !== true);
}

/**
 * One story's heart: whether it's on (see {@link HeartState}), whether its last change failed,
 * whether a change is on its way, and `press`.
 */
export function useHeart(storyId: string): {
  state: HeartState;
  failed: boolean;
  /** A change is on its way to the account (`aria-busy`). */
  busy: boolean;
  press: () => void;
} {
  useEffect(() => register(storyId), [storyId]);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => version,
    () => -1,
  );
  const session = usePersonalSession();
  const on =
    snapshot < 0
      ? undefined
      : session.status === 'signed-in'
        ? hearts.get(storyId)
        : hasDeviceHeart(storyId);
  return {
    state: on === undefined ? 'unknown' : on ? 'on' : 'off',
    failed: snapshot >= 0 && failed === storyId,
    busy: snapshot >= 0 && sending.has(storyId),
    press: useCallback(() => press(storyId), [storyId]),
  };
}

/**
 * The "My favourites" page loaded these for `userId`: every story it lists is hearted, no lookup
 * needed. Ignored if someone else is signed in now (an answer that arrived late).
 */
export function markHearted(userId: string, storyIds: readonly string[]) {
  if (owner !== userId) return;
  for (const id of storyIds) {
    hearts.set(id, true);
    wanted.delete(id);
  }
  if (storyIds.length) changed();
}

/**
 * Adds these stories to the signed-in person's hearts, like pressing each (the device prompt's
 * "Add"). Resolves with those added and those that couldn't be (a story no longer public is in
 * neither).
 */
export async function addHeartsToAccount(
  storyIds: readonly string[],
): Promise<{ added: string[]; failed: string[] }> {
  const session = personalSession();
  if (session.status !== 'signed-in')
    return { added: [], failed: [...storyIds] };
  // The same per-story queue as a press (Codex, #117 round 3), so a press made while one of
  // these is on its way still has the last word, and each story's real outcome is awaited
  // (round 4). Bound to this person: their session's token only (personalApiUser), and if
  // someone else signs in (or out) meanwhile it stops, adding nothing to anyone.
  const mine = generation;
  const added: string[] = [];
  const failedIds: string[] = [];
  for (const [i, id] of storyIds.entries()) {
    if (generation !== mine) return { added, failed: storyIds.slice(i) };
    const outcome = await setHeart(session, id, true);
    if (outcome === 'saved') added.push(id);
    else if (outcome === 'failed') failedIds.push(id);
  }
  if (generation !== mine) return { added: [], failed: [...storyIds] };
  return { added, failed: failedIds };
}
