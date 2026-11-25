/**
 * The one log format every service, job and worker writes (Joel, 2026-11-14, ops questions
 * OPS-2): one JSON object per line, which Cloud Logging reads as a structured entry.
 *
 *   {"severity":"INFO","message":"…","timestamp":"2026-11-14T12:00:00.000Z", …context fields}
 *
 * `severity` uses Cloud Logging's names. `timestamp` is ISO 8601 in UTC. Context fields (a Nest
 * context, a job's step, counts and ids) follow and never replace the three above. An error's
 * stack goes in `stack_trace`, in the same entry, where Error Reporting looks for it.
 *
 * Lines below `LOG_LEVEL` (default INFO) aren't written. No dependencies: the website's server
 * code uses it too. The NestJS logger is `@heisreal/logging/nest`.
 */

/** Cloud Logging's severities, lowest first (NOTICE: a normal but significant event). */
export const SEVERITIES = [
  'DEBUG',
  'INFO',
  'NOTICE',
  'WARNING',
  'ERROR',
  'CRITICAL',
] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Anything else a line carries: names, counts, ids. Never personal data, keys or story text. */
export type LogFields = Record<string, unknown>;

const DEFAULT_LEVEL: Severity = 'INFO';

/**
 * The lowest severity written: `LOG_LEVEL` (any case), or INFO when it is unset or isn't one of
 * {@link SEVERITIES}.
 */
export function minimumSeverity(
  env: Record<string, string | undefined> | undefined = globalThis.process?.env,
): Severity {
  const raw = env?.['LOG_LEVEL']?.trim().toUpperCase();
  return SEVERITIES.find((s) => s === raw) ?? DEFAULT_LEVEL;
}

/** Whether a line of `severity` is written when the lowest written is `minimum`. */
export function severityEnabled(
  severity: Severity,
  minimum: Severity = minimumSeverity(),
): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(minimum);
}

/**
 * The `service` group on every entry (LG-10, Joel 24 Nov 2026: "Let's add deployment details
 * too"): which code wrote it, and where. All plain; nothing about a person.
 *
 * - `name`: the service or job (`api-user`, `housekeeping`); the first name given to
 *   {@link serviceFields}, else Cloud Run's `K_SERVICE` / `CLOUD_RUN_JOB`.
 * - `version`: the git commit the image was built from (`SERVICE_VERSION`, baked into every image
 *   by Release Images: the commit's first 12 hex digits, `snapshot-<sha>` for a snapshot image);
 *   `dev` when unset (a developer's machine, tests, the media worker).
 * - `revision`: Cloud Run's `K_REVISION`, or a job's execution (`CLOUD_RUN_EXECUTION`).
 * - `env`: `GCP_PROJECT` without `heisreal-` (`dev`, `prod`); `local` without one.
 * - `region`, `instance`: from Google's metadata server, read once in the background after
 *   start-up on Cloud Run (`@heisreal/logging/event` does it); left off until it answers, and
 *   always off the machine (locally, the media worker).
 */
export interface ServiceFields {
  name?: string;
  version?: string;
  revision?: string;
  env?: string;
  region?: string;
  instance?: string;
}

let processName: string | undefined;
const instanceFields: { region?: string; instance?: string } = {};
/**
 * Reads the region and instance in the background and hands each over through `found` as soon as
 * it arrives (one slow value never holds back the other). Must not throw or keep the process up.
 */
let instanceLookup:
  | ((
      env: Record<string, string | undefined>,
      found: (fields: typeof instanceFields) => void,
    ) => void)
  | undefined;
let lookupStarted = false;

/**
 * Registers how the region and instance are read (Node only: `@heisreal/logging/event`), so
 * this module stays free of Node imports for the website's server code.
 */
export function setInstanceLookup(lookup: typeof instanceLookup): void {
  instanceLookup = lookup;
}

/** Starts the one region/instance lookup on Cloud Run. Never waits for it, never throws. */
function startInstanceLookup(env: Record<string, string | undefined>): void {
  if (lookupStarted || !instanceLookup) return;
  if (!env['K_SERVICE'] && !env['CLOUD_RUN_JOB']) return;
  lookupStarted = true;
  try {
    instanceLookup(env, (found) => Object.assign(instanceFields, found));
  } catch {
    // Logging never throws; the fields are simply left off.
  }
}

/** The `service` group for `name` (or this process's name). Never waits, never throws. */
export function serviceFields(
  name?: string,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): ServiceFields {
  if (name) processName ??= name;
  startInstanceLookup(env);
  const project = env['GCP_PROJECT']?.trim();
  const named = name ?? processName ?? env['K_SERVICE'] ?? env['CLOUD_RUN_JOB'];
  const revision = env['K_REVISION'] ?? env['CLOUD_RUN_EXECUTION'];
  return {
    ...(named ? { name: named } : {}),
    version: env['SERVICE_VERSION']?.trim() || 'dev',
    ...(revision ? { revision } : {}),
    env: project ? project.replace(/^heisreal-/, '') : 'local',
    ...instanceFields,
  };
}

/**
 * One entry as an object: the three shared fields first, then the context fields (a context
 * field named `severity`, `message` or `timestamp` is dropped, never written over them). Every
 * entry carries the `service` group ({@link serviceFields}): a line without one gets this
 * process's; an event's own gains the region and instance once they are known.
 */
export function logEntry(
  severity: Severity,
  message: string,
  fields: LogFields = {},
  now: Date = new Date(),
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    severity,
    message,
    timestamp: now.toISOString(),
  };
  const own = fields['service'];
  if (!own) entry['service'] = serviceFields();
  for (const [key, value] of Object.entries(fields)) {
    if (key in entry) continue;
    entry[key] =
      key === 'service' && typeof own === 'object'
        ? { ...own, ...instanceFields }
        : value;
  }
  return entry;
}

/** One entry as its JSON line (no newline). */
export function formatLogEntry(
  severity: Severity,
  message: string,
  fields?: LogFields,
  now?: Date,
): string {
  return JSON.stringify(logEntry(severity, message, fields, now));
}

/** Somewhere a finished entry goes besides stdout (Axiom, the media worker's Cloud Logging). */
export interface LogSink {
  write(severity: Severity, entry: Record<string, unknown>): void;
  /** Sends what is waiting; resolves (never rejects) within `timeoutMs`. For shutting down. */
  flush?(timeoutMs?: number): Promise<void>;
}

/**
 * The sinks every entry written to stdout also goes to (LG-3: Axiom), whichever writer wrote it:
 * {@link writeLog}, `JsonLogger`, and the wide, job and search events, `note` and error lines.
 * Kept on `globalThis`, not in this module: the website's server bundles this library more than
 * once, and every copy must reach the same sinks.
 */
interface SinkState {
  sinks: LogSink[];
  failed: number;
}
const SINKS = Symbol.for('heisreal.logging.sinks');
const sinkState = (): SinkState =>
  ((globalThis as { [SINKS]?: SinkState })[SINKS] ??= { sinks: [], failed: 0 });

/** Adds a sink for every entry from now on; the answer removes it again. */
export function addLogSink(sink: LogSink): () => void {
  sinkState().sinks.push(sink);
  return () => {
    const { sinks } = sinkState();
    const at = sinks.indexOf(sink);
    if (at >= 0) sinks.splice(at, 1);
  };
}

/** Counts one entry that couldn't be written (writes are swallowed, never thrown). */
export function countFailedLogWrite(count = 1): void {
  sinkState().failed += count;
}

/** How many entries couldn't be written, or sent, in this process. */
export function failedLogWrites(): number {
  return sinkState().failed;
}

/** Hands an entry already written to stdout to every other sink. Never throws, never waits. */
export function forwardLog(
  severity: Severity,
  entry: Record<string, unknown>,
): void {
  for (const sink of sinkState().sinks) {
    try {
      sink.write(severity, entry);
    } catch {
      countFailedLogWrite();
    }
  }
}

/**
 * Sends what every sink still holds, waiting at most `timeoutMs` in all: for shutting down
 * (SIGTERM) and for a job that is about to exit. Never rejects.
 */
export async function flushLogSinks(timeoutMs = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(
      sinkState().sinks.map((sink) => sink.flush?.(timeoutMs)),
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Writes a finished entry, if `LOG_LEVEL` allows it: ERROR and CRITICAL to stderr, the rest to
 * stdout (through `console`, so it also works in the website's server code), then to every
 * other sink ({@link addLogSink}).
 */
export function writeEntry(
  severity: Severity,
  entry: Record<string, unknown>,
): void {
  if (!severityEnabled(severity)) return;
  const line = JSON.stringify(entry);
  if (severity === 'ERROR' || severity === 'CRITICAL') console.error(line);
  else console.log(line);
  forwardLog(severity, entry);
}

/** Writes one entry ({@link writeEntry}), if `LOG_LEVEL` allows it. */
export function writeLog(
  severity: Severity,
  message: string,
  fields?: LogFields,
): void {
  if (!severityEnabled(severity)) return;
  writeEntry(severity, logEntry(severity, message, fields));
}

export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warning(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  critical(message: string, fields?: LogFields): void;
}

/** A writer whose every line also carries `context` (e.g. `{ job: 'housekeeping' }`). */
export function createLog(context: LogFields = {}): Log {
  const at =
    (severity: Severity) =>
    (message: string, fields?: LogFields): void =>
      writeLog(severity, message, { ...context, ...fields });
  return {
    debug: at('DEBUG'),
    info: at('INFO'),
    warning: at('WARNING'),
    error: at('ERROR'),
    critical: at('CRITICAL'),
  };
}
