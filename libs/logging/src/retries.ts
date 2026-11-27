/**
 * The retries rule (Joel, 2026-11-27; project/context/research/retries-cap.html): anything the
 * services, jobs or the media worker try again on their own is tried at most this many times IN
 * ALL, the first try included (RT-1 A: "first try + 2 retries").
 *
 * The four kinds (RT-16 A):
 * 1. A person is waiting (colliding saves, "Delete my account"): 3 quick tries, then the person
 *    sees the message they always saw.
 * 2. Background work (media jobs, the 18:00 resend, baseline Admins at start): 3 tries, then the
 *    nightly clean-up picks it up where one exists; it too stops after 3 nights.
 * 3. A duty that must finish (deleting an erased person's files and sign-in account, a deleted
 *    story's pictures): keeps trying for ever, slowly, with an ERROR line at every failure from
 *    the third on.
 * 4. Finding the way back (reconnecting to the database, the worker's certificate renewal,
 *    re-reading a secret or the log token): exempt (RT-2 A).
 *
 * Habits: retry in one place only; retry only what passes by itself (a collision, a timeout,
 * "busy"), never a refusal; waiting in line is not a failure. When the tries run out, write the
 * one shared ERROR line (`writeRetryLimit`, `@heisreal/logging/event`; RT-3: "for now just log").
 * Not measured first (RT-17): raise a number later only where errors show a real need.
 *
 * The browser has its own copy (apps/web/src/lib/retries.ts), and so does the deploy script
 * (libs/database/schema/migrate.py, MAX_TRIES).
 */
export const MAX_TRIES = 3;
