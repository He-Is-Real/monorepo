/**
 * The Axiom sink (LG-3, Joel 24–25 Nov 2026): every entry written to stdout also goes to Axiom,
 * the same fields after the same `LOG_LEVEL` filter, so Joel and agents read logs there first
 * (LG-5) and count them there (LG-8). Google keeps its own copy from stdout.
 *
 * - **Where:** Axiom's edge ingest API, `POST https://<AXIOM_DOMAIN>/v1/ingest/<AXIOM_DATASET>`
 *   (EU Central 1, `eu-central-1.aws.edge.axiom.co`; one dataset per environment, `heisreal-dev`,
 *   later `heisreal-prod`), with an ingest-only token from Secret Manager (`axiom-ingest-token`,
 *   named by `AXIOM_TOKEN_SECRET`). The entry's own `timestamp` is the event time.
 * - **Never in the way:** `write` only queues the entry and returns; the queue is sent as soon as
 *   the current turn of the event loop ends, in batches, by nobody who awaits it. A send with no
 *   answer in 10 s is tried once more with the next send (the next entry, or the flush at
 *   shutdown); a refusal, a second failure or Axiom dropping events is counted
 *   (`failedLogWrites()`) and dropped, with one warning on stdout at most once a minute; a full
 *   queue drops new entries the same way. No sampling.
 * - **Shutting down:** `flushLogSinks()` (`@heisreal/logging`) sends what is waiting, retrying a
 *   failed send once, all within one time cap; what is still unsent then is counted as dropped:
 *   the APIs on SIGTERM (Nest's shutdown hooks), housekeeping before it exits or on SIGTERM, the
 *   media worker when it stops.
 * - **Off unless configured:** it starts only where `AXIOM_DATASET`, `AXIOM_DOMAIN` and
 *   `AXIOM_TOKEN_SECRET` are set (OpenTofu, the media worker's script) and the token can be read.
 *   Locally and in tests none are set, so nothing is sent. A deployed service whose token is
 *   missing or empty writes one warning and logs to stdout only until a background re-read (once
 *   a minute) gets it: deploys never wait for the token (unlike the log keys, without which hashes
 *   could be reversed).
 */
import {
  countFailedLogWrite,
  addLogSink,
  formatLogEntry,
  type LogSink,
  type Severity,
  severityEnabled,
  writeLog,
} from './index';
import { TOKEN_RETRY_MS, tokenReader } from './token';

/** More than this many entries (or bytes) waiting means Axiom can't be reached: newer are dropped. */
const MAX_QUEUED = 2000;
const MAX_QUEUED_BYTES = 20_000_000;
/** One request carries at most this much (Axiom takes up to 10 000 events per request). */
const MAX_BATCH = 1000;
const MAX_BATCH_BYTES = 4_000_000;
/** A send with no answer by then has failed. */
const SEND_TIMEOUT_MS = 10_000;
const WARN_EVERY_MS = 60_000;

const DOMAIN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DATASET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AxiomOptions {
  /** The edge deployment's domain: `eu-central-1.aws.edge.axiom.co`. */
  domain: string;
  /** `heisreal-dev`, `heisreal-prod`. */
  dataset: string;
  /** An ingest-only API token for that dataset. */
  token: string;
  /** Tests pass their own. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface AxiomSink extends LogSink {
  /** Sends what is queued; resolves (never rejects) within `timeoutMs`. */
  flush(timeoutMs?: number): Promise<void>;
  /** Entries that couldn't be sent (dropped). */
  failed(): number;
}

export function axiomSink({
  domain,
  dataset,
  token,
  fetch: send = globalThis.fetch,
  now = Date.now,
}: AxiomOptions): AxiomSink {
  if (!DOMAIN.test(domain)) throw new Error('AXIOM_DOMAIN is malformed');
  if (!DATASET.test(dataset)) throw new Error('AXIOM_DATASET is malformed');
  const url = `https://${domain}/v1/ingest/${dataset}?timestamp-field=timestamp`;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  /** Each entry as its JSON, serialised once when written; `retried` after one failed send. */
  const queue: { line: string; retried: boolean }[] = [];
  let queuedBytes = 0;
  let scheduled = false;
  let sending: Promise<void> | undefined;
  /** The batch being sent; set aside once a shutdown flush gave up on it (already counted). */
  let inFlight: unknown[] | undefined;
  let abandoned: unknown[] | undefined;
  /** A send got no answer: wait for the next entry or a flush before trying again. */
  let paused = false;
  let failed = 0;
  let lastWarning = -Infinity;

  const drop = (count: number) => {
    if (count <= 0) return;
    failed += count;
    countFailedLogWrite(count);
    if (now() - lastWarning < WARN_EVERY_MS) return;
    lastWarning = now();
    // stdout only: this line is about the sink itself.
    if (severityEnabled('WARNING')) {
      console.log(
        formatLogEntry('WARNING', "Couldn't send log lines to Axiom", {
          event: 'logging',
          dropped_count: failed,
        }),
      );
    }
  };

  const nextBatch = () => {
    let bytes = 0;
    let count = 0;
    while (count < queue.length && count < MAX_BATCH) {
      const size = (queue[count]?.line.length ?? 0) + 1;
      if (count > 0 && bytes + size > MAX_BATCH_BYTES) break;
      bytes += size;
      count++;
    }
    queuedBytes -= bytes;
    return queue.splice(0, count);
  };

  const sendAll = async () => {
    while (queue.length) {
      const batch = nextBatch();
      inFlight = batch;
      let response: Response;
      try {
        response = await send(url, {
          method: 'POST',
          headers,
          body: `[${batch.map((e) => e.line).join(',')}]`,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        inFlight = undefined;
        // A shutdown flush already counted this batch as lost.
        if (batch === abandoned) return;
        // No answer (the network, or Cloud Run's CPU throttled between requests): entries get
        // one more try with the next send; the rest are dropped.
        const again = batch.filter((e) => !e.retried);
        drop(batch.length - again.length);
        for (const e of again) e.retried = true;
        queue.unshift(...again);
        queuedBytes += again.reduce((n, e) => n + e.line.length + 1, 0);
        paused = again.length > 0;
        return;
      }
      inFlight = undefined;
      if (batch === abandoned) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        // A refusal (bad token, over the plan's limit) won't change by trying again.
        drop(batch.length);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      // 200 with some events refused (a bad timestamp): count those.
      const answer = (await response.json().catch(() => ({}))) as {
        failed?: unknown;
      };
      if (typeof answer.failed === 'number') drop(answer.failed);
    }
  };

  const start = (): Promise<void> => {
    paused = false;
    sending ??= sendAll()
      .catch(() => undefined)
      .finally(() => {
        sending = undefined;
        if (queue.length && !paused) void start();
      });
    return sending;
  };

  return {
    write(severity: Severity, entry: Record<string, unknown>) {
      try {
        if (!severityEnabled(severity)) return;
        const line = JSON.stringify(entry);
        if (
          queue.length >= MAX_QUEUED ||
          queuedBytes + line.length > MAX_QUEUED_BYTES
        ) {
          return drop(1);
        }
        queue.push({ line, retried: false });
        queuedBytes += line.length + 1;
        if (scheduled) return;
        scheduled = true;
        // Every entry written in this turn (an error line and its event) goes in one request.
        setImmediate(() => {
          scheduled = false;
          void start();
        });
      } catch {
        drop(1);
      }
    },
    async flush(timeoutMs = 3000) {
      // One deadline for everything: the queue, newer entries and the one retry a failed send
      // allows (each entry fails at most twice, so this ends). What is still waiting or unanswered
      // when it passes is counted as dropped: the process is about to exit.
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drain = async () => {
        while (!expired && (queue.length || sending)) await start();
      };
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            abandoned = inFlight;
            drop(queue.length + (inFlight?.length ?? 0));
            queue.length = 0;
            queuedBytes = 0;
            resolve();
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
    failed: () => failed,
  };
}

const STARTED = Symbol.for('heisreal.logging.axiom');
type Started = {
  sink?: AxiomSink;
  remove?: () => void;
  /** The background re-read while the token can't be read. */
  retry?: ReturnType<typeof setTimeout>;
};
const started = globalThis as { [STARTED]?: Started };

/**
 * Adds the Axiom sink to every entry from now on, if this process is configured for it:
 * `AXIOM_DATASET`, `AXIOM_DOMAIN` and `AXIOM_TOKEN_SECRET` (the token's Secret Manager name),
 * read with `read` (libs/secrets). None set: nothing happens (local runs, tests). Partly set: one
 * warning, and logs keep going to stdout only. A token that can't be read or is empty: one warning
 * (the error's type and code, `./token.ts`), logs go to stdout only meanwhile, and a background
 * timer reads it again once a minute (`retryMs`) until it can; the sink is added then. Never
 * throws, never waits for a retry; a second call does nothing.
 */
export async function startAxiomLogs({
  read,
  env = globalThis.process?.env ?? {},
  fetch: send,
  retryMs = TOKEN_RETRY_MS,
}: {
  read?: (secretName: string) => Promise<string>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Tests: the wait between reads while the token can't be read (a minute). */
  retryMs?: number;
}): Promise<AxiomSink | undefined> {
  if (started[STARTED]) return started[STARTED].sink;
  const dataset = env['AXIOM_DATASET']?.trim();
  const domain = env['AXIOM_DOMAIN']?.trim();
  const secret = env['AXIOM_TOKEN_SECRET']?.trim();
  if (!dataset && !domain && !secret) return undefined;
  const warning = 'Logs go to stdout only, not to Axiom';
  const warn = (reason: string) => {
    writeLog('WARNING', `${warning}: ${reason}`, { event: 'startup' });
    return undefined;
  };
  if (!dataset || !domain || !secret || !read) {
    return warn(
      'AXIOM_DATASET, AXIOM_DOMAIN and AXIOM_TOKEN_SECRET must all be set',
    );
  }
  const state: Started = {};
  started[STARTED] = state;
  // The timer below spaces the reads, so the reader itself never holds one back.
  const token = tokenReader({ secret, read, warning, retryMs: 0 });
  const attach = (value: string) => {
    try {
      const sink = axiomSink({ domain, dataset, token: value, fetch: send });
      state.sink = sink;
      state.remove = addLogSink(sink);
      return sink;
    } catch (err) {
      return warn(err instanceof Error ? err.message : 'bad settings');
    }
  };
  const retry = () => {
    state.retry = setTimeout(() => {
      state.retry = undefined;
      void token().then((value) => {
        // Reset (tests) while reading: this attempt belongs to a forgotten start.
        if (started[STARTED] !== state) return;
        if (value === undefined) retry();
        else attach(value);
      });
    }, retryMs);
    state.retry.unref?.();
  };
  const value = await token();
  if (started[STARTED] !== state) return undefined;
  if (value !== undefined) return attach(value);
  retry();
  return undefined;
}

/** Stops sending to Axiom and forgets the sink (tests). */
export function resetAxiomLogs(): void {
  const current = started[STARTED];
  current?.remove?.();
  clearTimeout(current?.retry);
  delete started[STARTED];
}
