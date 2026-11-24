/**
 * The browser's small error reports (LG-1c, LG-9a; Joel 22–24 Nov 2026): when the page crashes
 * in the browser (`browser_crash`), or one of its calls to our APIs got no answer
 * (`no_answer`: offline, a timeout), it tells api-user the reference it showed, the page's path
 * and the kind (`POST /v1/error-reports`, which writes one log line). Server errors are never
 * reported from here: anyone can read their own network traffic, so the servers log those.
 *
 * Held in this page's memory only, never the browser's storage (device storage law, LG-1c), and
 * dropped if the page closes first. A "no answer" report waits until the connection is back:
 * the next call that gets an answer, the browser coming back online, or a retry every 30 s.
 */

/** What went wrong (api-user's `ErrorReport.kind`). */
export type ErrorReportKind = 'browser_crash' | 'no_answer';

export interface ErrorReport {
  reference: string;
  route: string;
  kind: ErrorReportKind;
}

/** Reports kept at most; past it the oldest go. */
const MAX_WAITING = 20;
const RETRY_MS = 30_000;
const TIMEOUT_MS = 10_000;

let base: string | undefined;
const waiting: ErrorReport[] = [];
let sending = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let listening = false;

/** Where reports go: api-user's address (the root layout's `ErrorReports` sets it). */
export function setErrorReportsUrl(url: string | undefined): void {
  base = url?.replace(/\/+$/, '') || undefined;
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('online', () => void flushErrorReports());
  }
  void flushErrorReports();
}

/** The page's path, never its query or fragment (a query can hold search words). */
const currentRoute = (): string =>
  typeof location === 'undefined' ? '/' : location.pathname.slice(0, 300);

function add(report: ErrorReport): void {
  if (waiting.some((r) => r.reference === report.reference)) return;
  waiting.push(report);
  if (waiting.length > MAX_WAITING) waiting.shift();
}

/** The page crashed in the browser: report it now. */
export function reportBrowserCrash(reference: string): void {
  add({ reference, route: currentRoute(), kind: 'browser_crash' });
  void flushErrorReports();
}

/** A call got no answer: report it once the page can reach us again. */
export function reportNoAnswer(reference: string): void {
  add({ reference, route: currentRoute(), kind: 'no_answer' });
  schedule();
}

function schedule(): void {
  if (retry || !waiting.length || typeof window === 'undefined') return;
  retry = setTimeout(() => {
    retry = undefined;
    void flushErrorReports();
  }, RETRY_MS);
}

/**
 * Sends what is waiting, one at a time. A report that got any answer is done (it reached us); one
 * that got none stays for the next try.
 */
export async function flushErrorReports(): Promise<void> {
  if (sending || !base || !waiting.length) return;
  sending = true;
  try {
    while (waiting.length) {
      const report = waiting[0];
      try {
        await fetch(`${base}/v1/error-reports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report),
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        break;
      }
      waiting.shift();
    }
  } finally {
    sending = false;
    schedule();
  }
}

/** Tests: what is waiting. */
export const waitingErrorReports = (): readonly ErrorReport[] => waiting;
