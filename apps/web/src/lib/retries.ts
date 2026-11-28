/**
 * The retries rule in the browser (Joel, 2026-11-27; project/context/research/retries-cap.html):
 * anything the page tries again on its own is tried at most this many times IN ALL, the first try
 * included (RT-1 A: "first try + 2 retries"). A person is waiting, so after the last try they see
 * the message they always saw (kind 1): autosave's "Your story couldn't be saved…", an upload's
 * "Upload failed" with "Try again". Never retried: a refusal (it would fail the same way).
 *
 * The services, jobs and media worker share their own copy (libs/logging `MAX_TRIES`), where the
 * four kinds of retry are written out.
 */
export const MAX_TRIES = 3;
