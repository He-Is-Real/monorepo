// What the submit flow keeps in the tab's sessionStorage (components/share/use-draft.ts): a
// person's unsaved text and unresolved submissions, under keys scoped to them (their Clerk user
// id), so nothing of one person's is shown to, or sent as, the next person in the tab.

/** Every key starts `heisreal:share:<owner>:`. */
export const PREFIX = 'heisreal:share:';

/**
 * Forgets everything the submit flow kept in this tab except `owner`'s: everyone's when
 * `owner` is null (nobody is signed in). It doesn't wait to see someone sign out (Clerk's
 * sign-out leaves the page before telling it): whoever is signed in now, or nobody, is enough.
 */
export function forgetShareStorageExcept(owner: string | null) {
  try {
    const store = window.sessionStorage;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (
        key?.startsWith(PREFIX) &&
        (owner === null || !key.startsWith(`${PREFIX}${owner}:`))
      ) {
        store.removeItem(key);
      }
    }
  } catch {
    // storage blocked: nothing kept to forget
  }
}

/** Forgets what the submit flow kept in this tab for `owner` only (their account was deleted). */
export function forgetShareStorageOf(owner: string) {
  try {
    const store = window.sessionStorage;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith(`${PREFIX}${owner}:`)) store.removeItem(key);
    }
  } catch {
    // storage blocked: nothing kept to forget
  }
}
