import { type Severity, severityEnabled, writeLog } from '@heisreal/logging';
import { type LogSink, TRACE_FIELD } from '@heisreal/logging/event';

/**
 * The worker's lines in Cloud Logging (LG-4 A; logging build, Joel 24 Nov 2026). The worker runs
 * off Google Cloud, so nothing collects its stdout: it sends each line itself, as the media-worker
 * account (roles/logging.logWriter, infra/terraform/modules/gcp/media.tf), to the London bucket
 * through the `_Default` sink like every other line. stdout keeps the same JSON locally.
 *
 * Sending never fails, slows or changes a job: `write` only queues the line; the queue is sent
 * a moment later without anyone awaiting it; a send that fails is counted and dropped (one
 * warning on stdout, at most once a minute), and a full queue drops new lines the same way.
 */

/** What the sink needs of Google's client: an authorised POST (tests pass their own). */
export interface LoggingClient {
  request(options: {
    url: string;
    method: 'POST';
    data: unknown;
  }): Promise<unknown>;
}

export interface CloudLoggingSink extends LogSink {
  /** Sends what is queued; resolves (never rejects) within `timeoutMs`. For shutting down. */
  flush(timeoutMs?: number): Promise<void>;
  /** Lines that couldn't be sent (dropped). */
  failed(): number;
}

const ENTRIES_WRITE = 'https://logging.googleapis.com/v2/entries:write';
/** More than this waiting means Google can't be reached: newer lines are dropped. */
const MAX_QUEUED = 1000;
/** Lines per request (Google takes many more; small requests keep a failure small). */
const BATCH = 100;
const WARN_EVERY_MS = 60_000;

/**
 * One of our JSON lines as a Cloud Logging entry: `severity`, `timestamp` and the trace field
 * become the entry's own fields (Cloud Run does the same with a service's stdout); the rest,
 * `message` first, is its `jsonPayload`.
 */
export function cloudEntry(
  project: string,
  severity: Severity,
  line: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (key !== 'severity' && key !== 'timestamp' && key !== TRACE_FIELD) {
      payload[key] = value;
    }
  }
  const trace = line[TRACE_FIELD];
  return {
    logName: `projects/${project}/logs/media-worker`,
    // A machine outside Google Cloud; no machine name (the worker's identity says which account).
    resource: {
      type: 'generic_node',
      labels: {
        project_id: project,
        location: 'europe-west2',
        namespace: 'media',
        node_id: 'media-worker',
      },
    },
    severity,
    ...(typeof line['timestamp'] === 'string'
      ? { timestamp: line['timestamp'] }
      : {}),
    ...(typeof trace === 'string' ? { trace } : {}),
    jsonPayload: payload,
  };
}

export function cloudLoggingSink(
  project: string,
  client: LoggingClient,
  now: () => number = Date.now,
): CloudLoggingSink {
  const queue: Record<string, unknown>[] = [];
  let sending: Promise<void> | undefined;
  let failed = 0;
  let lastWarning = -Infinity;

  const drop = (count: number) => {
    failed += count;
    if (now() - lastWarning < WARN_EVERY_MS) return;
    lastWarning = now();
    // stdout only: this line is about the sink itself.
    writeLog('WARNING', "Couldn't send log lines to Cloud Logging", {
      event: 'logging',
      dropped_count: failed,
    });
  };

  const sendAll = async () => {
    while (queue.length) {
      const entries = queue.splice(0, BATCH);
      try {
        await client.request({
          url: ENTRIES_WRITE,
          method: 'POST',
          data: { entries, partialSuccess: true },
        });
      } catch {
        drop(entries.length);
      }
    }
  };

  const start = () => {
    sending ??= sendAll().finally(() => {
      sending = undefined;
      if (queue.length) start();
    });
    return sending;
  };

  return {
    write(severity, entry) {
      try {
        if (!severityEnabled(severity)) return;
        if (queue.length >= MAX_QUEUED) return drop(1);
        queue.push(cloudEntry(project, severity, entry));
        setImmediate(start);
      } catch {
        failed++;
      }
    },
    async flush(timeoutMs = 3000) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        start(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
    failed: () => failed,
  };
}
