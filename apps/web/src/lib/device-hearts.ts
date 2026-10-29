'use client';

import { useSyncExternalStore } from 'react';
import { STORY_ID } from '@/lib/browse';

/**
 * Hearts kept on this device (M2; Joel, 2026-10-28: "make hearts for non signed in users be
 * stored in their browser cache indefinitely"). Signed out, a heart is saved here only: in this
 * browser's local storage, with no expiry, and nothing reaches our servers, so it needs no
 * account and no consent. Clearing the browser's data removes it (listed on /privacy).
 *
 * The list is the device's, not a person's: it never goes into an account on its own. After
 * signing in, the person is asked whether to add these to their account
 * (device-hearts-prompt.tsx). The list itself stays as it is; hearts added are marked, so they
 * aren't offered again (to anyone, on this device).
 *
 * Every tab of this browser sees the same list (the `storage` event).
 */

export const DEVICE_HEARTS_KEY = 'heisreal:device-hearts';
/** Kept newest first; beyond this many, the oldest go (a bound on what one device keeps). */
export const DEVICE_HEARTS_MAX = 1000;

interface DeviceHeart {
  id: string;
  /** When it was hearted (ms). */
  at: number;
  /** When "Add" put it into an account from this device (ms): not offered again. */
  addedAt?: number;
}

const EMPTY: readonly DeviceHeart[] = [];
let cache: readonly DeviceHeart[] | null = null;
const listeners = new Set<() => void>();

function read(): readonly DeviceHeart[] {
  if (cache) return cache;
  let list: DeviceHeart[] = [];
  try {
    const raw = window.localStorage.getItem(DEVICE_HEARTS_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as { v?: unknown; hearts?: unknown })
      : null;
    if (parsed?.v === 1 && Array.isArray(parsed.hearts))
      list = parsed.hearts.filter(
        (h): h is DeviceHeart =>
          !!h &&
          typeof h === 'object' &&
          typeof (h as DeviceHeart).id === 'string' &&
          STORY_ID.test((h as DeviceHeart).id) &&
          typeof (h as DeviceHeart).at === 'number' &&
          ((h as DeviceHeart).addedAt === undefined ||
            typeof (h as DeviceHeart).addedAt === 'number'),
      );
  } catch {
    // Unreadable or storage off: an empty list.
  }
  cache = list;
  return cache;
}

function write(list: DeviceHeart[]) {
  cache = list;
  try {
    if (list.length === 0) window.localStorage.removeItem(DEVICE_HEARTS_KEY);
    else
      window.localStorage.setItem(
        DEVICE_HEARTS_KEY,
        JSON.stringify({ v: 1, hearts: list }),
      );
  } catch {
    // Storage off or full: kept for this page only.
  }
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  // Another tab changed the list (or cleared the site's data).
  window.addEventListener('storage', (event) => {
    if (event.key !== DEVICE_HEARTS_KEY && event.key !== null) return;
    cache = null;
    for (const l of listeners) l();
  });
}

export const onDeviceHearts = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether this device keeps a heart on the story. */
export const hasDeviceHeart = (storyId: string): boolean =>
  read().some((h) => h.id === storyId);

/** The device's hearted story ids, newest heart first. */
export const deviceHeartIds = (): string[] => read().map((h) => h.id);

/** Puts the story's heart on or off on this device. */
export function setDeviceHeart(storyId: string, on: boolean) {
  if (!STORY_ID.test(storyId)) return;
  const rest = read().filter((h) => h.id !== storyId);
  write(
    on
      ? [{ id: storyId, at: Date.now() }, ...rest].slice(0, DEVICE_HEARTS_MAX)
      : rest,
  );
}

/** The hearts not yet added to an account from this device ("Add" offers these), newest first. */
export const deviceHeartIdsToOffer = (): string[] =>
  read()
    .filter((h) => h.addedAt === undefined)
    .map((h) => h.id);

/** "Add" put these into an account: the list stays the same, they just aren't offered again. */
export function markAddedToAccount(storyIds: readonly string[]) {
  if (storyIds.length === 0) return;
  const now = Date.now();
  const added = new Set(storyIds);
  write(read().map((h) => (added.has(h.id) ? { ...h, addedAt: now } : h)));
}

/** The device's hearted ids, newest first; empty on the server and while hydrating. */
export function useDeviceHeartIds(): readonly string[] {
  const list = useSyncExternalStore(onDeviceHearts, read, () => EMPTY);
  return list.map((h) => h.id);
}
