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
 * One entry as an object: the three shared fields first, then the context fields (a context
 * field named `severity`, `message` or `timestamp` is dropped, never written over them).
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
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in entry)) entry[key] = value;
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

/**
 * Writes one entry, if `LOG_LEVEL` allows it: ERROR and CRITICAL to stderr, the rest to stdout
 * (through `console`, so it also works in the website's server code).
 */
export function writeLog(
  severity: Severity,
  message: string,
  fields?: LogFields,
): void {
  if (!severityEnabled(severity)) return;
  const line = formatLogEntry(severity, message, fields);
  if (severity === 'ERROR' || severity === 'CRITICAL') console.error(line);
  else console.log(line);
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
