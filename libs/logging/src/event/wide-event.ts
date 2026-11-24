import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import {
  type LogFields,
  logEntry,
  type Severity,
  severityEnabled,
} from '../index';
import { logHash, searchHash } from './keys';
import {
  cloudTrace,
  newTrace,
  type Trace,
  TRACE_FIELD,
  traceparentFor,
} from './trace';
import { clientKind } from './user-agent';

/**
 * One wide event per request or job (the writing-logs skill; LG-2 C, Joel 22 Nov 2026): started
 * at the edge, given fields while the work runs, written once when it ends, success or failure.
 * Field names and data classes: the skill's tables and LG-2 of the logging decision doc.
 */

/** How the work ended, in words we can count. */
export type Outcome =
  | 'ok'
  | 'input_refused'
  | 'not_found'
  | 'rate_limited'
  | 'restarting'
  /** Any other refusal: not signed in, not allowed, a conflict or a precondition. */
  | 'refused'
  | 'error';

/** Outcomes whose long text is written in full (LG-2e, LG-9b B). */
const PLAIN_LONG_TEXT: ReadonlySet<Outcome> = new Set([
  'error',
  'input_refused',
  'rate_limited',
]);

export type EventKind = 'request' | 'job';

export interface ServiceFields {
  name: string;
  version?: string;
  revision?: string;
  env?: string;
}

/**
 * The `service` group: our name, Cloud Run's revision (`K_REVISION`) and the environment
 * (`GCP_PROJECT` without `heisreal-`; `local` without one).
 */
export function serviceFields(
  name: string,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): ServiceFields {
  const project = env['GCP_PROJECT']?.trim();
  return {
    name,
    ...(env['K_REVISION'] ? { revision: env['K_REVISION'] } : {}),
    env: project ? project.replace(/^heisreal-/, '') : 'local',
  };
}

/** `error.*` on the event: our own words, never what someone sent. */
export interface ErrorFields {
  type: string;
  code?: string;
  retriable?: boolean;
  /** Written by us; never quotes a request or a database error. */
  message?: string;
}

interface Timing {
  calls: number;
  total_ms: number;
  slowest?: { name: string; ms: number };
}

interface ExternalTiming {
  calls: number;
  ms: number;
  status?: number | string;
}

/**
 * Where the finished line goes. Today only stdout (Cloud Run hands it to Cloud Logging, London).
 * TODO(Axiom, LG-3): add the Axiom sink here once the account exists; it must send after the
 * response without being awaited on the request path, and swallow and count its failures.
 */
export interface LogSink {
  write(severity: Severity, entry: Record<string, unknown>): void;
}

const stdoutSink: LogSink = {
  write(severity, entry) {
    if (!severityEnabled(severity)) return;
    const line = JSON.stringify(entry);
    if (severity === 'ERROR' || severity === 'CRITICAL') console.error(line);
    else console.log(line);
  },
};

/** Every sink an event is written to. */
export const LOG_SINKS: LogSink[] = [stdoutSink];

let failedWrites = 0;
/** How many event writes failed in this process (they are swallowed, never thrown). */
export function failedLogWrites(): number {
  return failedWrites;
}

function emit(severity: Severity, entry: Record<string, unknown>): void {
  for (const sink of LOG_SINKS) {
    try {
      sink.write(severity, entry);
    } catch {
      failedWrites++;
    }
  }
}

/**
 * Google refuses a log entry over 256 KB. A line longer than this has its plain long text cut
 * (longest first) until it fits, and says which fields were cut (`debug.truncated_fields`);
 * their `_length` keeps the full length.
 */
export const MAX_ENTRY_BYTES = 200_000;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Never copied: they would reach an object's prototype instead of a field. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function merge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isObject(value) && isObject(current)) merge(current, value);
    else if (isObject(value)) {
      const copy: Record<string, unknown> = {};
      merge(copy, value);
      target[key] = copy;
    } else target[key] = value;
  }
}

/** `{ a: { b: value } }` for `a.b`. */
function atPath(path: string, value: unknown): Record<string, unknown> {
  return path
    .split('.')
    .reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<
    string,
    unknown
  >;
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  let at: unknown = root;
  for (const key of path.split('.')) {
    if (!isObject(at)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * Field names left out of a logged body, at any depth (the "Never" class): every credential,
 * key, signature and session id, whatever its case or separators (`accessKey`, `api_key`,
 * `X-Session-Id`, `sid`).
 */
const SECRET_PART =
  /token|secret|passw|passphrase|passcode|authori[sz]ation|cookie|signature|session|credential|key|bearer|jwt|card|cvc|cvv/;
const SECRET_WHOLE = /^(pass|pwd|auth|sig|sid|otp|pin)$|sid$/;

/** Whether a field with this name holds a secret or a session id (never logged). */
export function isSecretField(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_PART.test(flat) || SECRET_WHOLE.test(flat);
}

/** A request body with every secret-looking field removed (the skill: "strip them from bodies"). */
export function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[deep]';
  if (Array.isArray(value))
    return value.map((v) => withoutSecrets(v, depth + 1));
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!isSecretField(key) && !UNSAFE_KEYS.has(key))
      out[key] = withoutSecrets(v, depth + 1);
  }
  return out;
}

export class WideEvent {
  readonly ref: string;
  readonly traceId: string;
  private readonly fields: Record<string, unknown> = {};
  private readonly longTexts = new Map<string, string>();
  private readonly db: Timing = { calls: 0, total_ms: 0 };
  private readonly external: Record<string, ExternalTiming> = {};
  private readonly startedAt = performance.now();
  private finished = false;
  private messageText?: string;

  constructor(
    readonly kind: EventKind,
    readonly service: ServiceFields,
    trace: Trace = newTrace(),
  ) {
    this.ref = trace.ref;
    this.traceId = trace.traceId;
  }

  /** Adds plain fields, merged into the groups already there. Never throws. */
  set(fields: LogFields): this {
    try {
      merge(this.fields, fields);
    } catch {
      // Logging never throws into business code.
    }
    return this;
  }

  /** A field already set (`'user.id'`). */
  get(path: string): unknown {
    return readPath(this.fields, path);
  }

  /** How it ended so far (undefined until someone says). */
  get outcome(): Outcome | undefined {
    return this.fields['outcome'] as Outcome | undefined;
  }

  /** Sets the outcome unless one is already set (`force` replaces it). */
  setOutcome(outcome: Outcome, { force = false } = {}): this {
    if (force || !this.fields['outcome']) this.fields['outcome'] = outcome;
    return this;
  }

  /**
   * Long text (hash unless error, LG-9c): decided when the event is written. In full under
   * `path` when the work ends in an error, an input refusal or a rate limit; otherwise only
   * `<path>_hash` (general key). `<path>_length` either way.
   */
  longText(path: string, value: string | undefined | null): this {
    if (typeof value === 'string') this.longTexts.set(path, value);
    return this;
  }

  /**
   * A sensitive value (Clerk's session id, the token) as a keyed hash under `path`, which must
   * end in `_hash`. Never plain, not on error.
   */
  sensitive(path: string, value: string | undefined | null): this {
    if (!path.endsWith('_hash')) return this;
    if (typeof value === 'string' && value) {
      try {
        this.set(atPath(path, logHash(value)));
      } catch {
        // never throws
      }
    }
    return this;
  }

  /** Records a failure: its outcome (default `error`) and `error.*`. */
  fail(error: ErrorFields, outcome: Outcome = 'error'): this {
    this.setOutcome(outcome, { force: true });
    return this.set({ error });
  }

  /** One SurrealDB query or function call. */
  recordDb(name: string, ms: number): void {
    const rounded = Math.round(ms);
    this.db.calls++;
    this.db.total_ms += rounded;
    if (!this.db.slowest || rounded > this.db.slowest.ms) {
      this.db.slowest = { name, ms: rounded };
    }
  }

  /** One call to Clerk, Bunny, Stripe or Resend; `status`: its HTTP status, or what went wrong. */
  recordExternal(name: string, ms: number, status?: number | string): void {
    const timing = (this.external[name] ??= { calls: 0, ms: 0 });
    timing.calls++;
    timing.ms += Math.round(ms);
    if (status !== undefined) timing.status = status;
  }

  /** The `db` group so far (for a search event). */
  dbTimings(): Timing | undefined {
    return this.db.calls ? structuredClone(this.db) : undefined;
  }

  /** Milliseconds since the event started. */
  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  /** The short human summary (`POST /v1/stories 201 in 41 ms`). Never holds request data. */
  message(text: string): this {
    this.messageText = text;
    return this;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** The finished entry and its severity, without writing it (`write` writes it). */
  build(now: Date = new Date()): {
    severity: Severity;
    entry: Record<string, unknown>;
  } {
    const outcome = (this.fields['outcome'] as Outcome | undefined) ?? 'ok';
    const severity: Severity =
      outcome === 'error'
        ? 'ERROR'
        : outcome === 'rate_limited' || outcome === 'restarting'
          ? 'WARNING'
          : 'INFO';
    const body: Record<string, unknown> = structuredClone(this.fields);
    body['outcome'] = outcome;
    // The search terms live only on the separate search event (LG-2g A).
    delete body['search'];
    const plain = PLAIN_LONG_TEXT.has(outcome);
    for (const [path, value] of this.longTexts) {
      const key = lastKey(path);
      const leaf = {
        [key]: plain ? value : undefined,
        [`${key}_hash`]: plain ? undefined : logHash(value),
        [`${key}_length`]: value.length,
      };
      const parent = path.slice(0, Math.max(0, path.lastIndexOf('.')));
      merge(body, parent ? atPath(parent, leaf) : leaf);
    }
    if (this.longTexts.size) {
      merge(body, { debug: { plain_content: plain } });
    }
    if (this.db.calls) merge(body, { db: this.db });
    if (Object.keys(this.external).length) {
      merge(body, { external: this.external });
    }
    const trace = cloudTrace(this.traceId);
    const ordered: Record<string, unknown> = {
      event: this.kind,
      ref: this.ref,
      ...(trace ? { [TRACE_FIELD]: trace } : {}),
      service: this.service,
    };
    merge(ordered, body);
    const message =
      this.messageText ?? `${this.kind} ${outcome} in ${this.elapsedMs()} ms`;
    let entry = logEntry(severity, message, ordered, now);
    if (plain && bytes(entry) > MAX_ENTRY_BYTES) {
      entry = this.cut(entry);
    }
    return { severity, entry };
  }

  /**
   * Writes the event once (later calls do nothing). Never throws, never awaits: a failed write
   * can't fail, slow or change the request.
   */
  write(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      const { severity, entry } = this.build();
      emit(severity, entry);
    } catch {
      failedWrites++;
    }
  }

  /** Cuts plain long text, longest first, until the entry fits {@link MAX_ENTRY_BYTES}. */
  private cut(entry: Record<string, unknown>): Record<string, unknown> {
    const cutFields: string[] = [];
    const paths = [...this.longTexts.keys()].sort(
      (a, b) =>
        (this.longTexts.get(b)?.length ?? 0) -
        (this.longTexts.get(a)?.length ?? 0),
    );
    for (const path of paths) {
      const over = bytes(entry) - MAX_ENTRY_BYTES;
      if (over <= 0) break;
      const value = readPath(entry, path);
      if (typeof value !== 'string') continue;
      // Characters can be up to 4 bytes in UTF-8: cut generously, then check again.
      const keep = Math.max(0, value.length - over - 1024);
      merge(entry, atPath(path, value.slice(0, keep)));
      cutFields.push(path);
    }
    if (cutFields.length) {
      merge(entry, { debug: { truncated_fields: cutFields } });
    }
    if (bytes(entry) <= MAX_ENTRY_BYTES) return entry;
    // Still too long (not long text): keep only what finds and explains the request.
    const keep = [
      'severity',
      'message',
      'timestamp',
      'event',
      'ref',
      TRACE_FIELD,
      'service',
      'http',
      'action',
      'outcome',
      'error',
    ];
    const small: Record<string, unknown> = {};
    for (const key of keep) if (key in entry) small[key] = entry[key];
    small['debug'] = { oversized: true };
    return small;
  }
}

const lastKey = (path: string) => path.slice(path.lastIndexOf('.') + 1);

const storage = new AsyncLocalStorage<WideEvent>();

/** Starts a wide event. Pass it down with {@link runWithEvent}. */
export function startEvent(
  kind: EventKind,
  service: ServiceFields | string,
  trace?: Trace,
): WideEvent {
  return new WideEvent(
    kind,
    typeof service === 'string' ? serviceFields(service) : service,
    trace,
  );
}

/** Runs `work` with `event` as the current event (for the code it calls, however deep). */
export function runWithEvent<T>(event: WideEvent, work: () => T): T {
  return storage.run(event, work);
}

/** The request's or job's event, if the code runs inside one. */
export function currentEvent(): WideEvent | undefined {
  return storage.getStore();
}

/**
 * A fact about the current work: a field on its event while there is one still open (LG-2 C:
 * lines inside a request are folded into it). Otherwise its own line: for background work outside
 * any request, or for work that goes on after its request's event was written (the caller hung
 * up), in which case the line carries that request's `ref`, trace and service so it still joins.
 */
export function note(
  fields: LogFields,
  line: { severity: Severity; message: string },
): void {
  const event = currentEvent();
  if (event && !event.isFinished) {
    event.set(fields);
    return;
  }
  try {
    const entry: Record<string, unknown> = {};
    if (event) {
      const trace = cloudTrace(event.traceId);
      merge(entry, {
        ref: event.ref,
        ...(trace ? { [TRACE_FIELD]: trace } : {}),
        service: event.service,
      });
    }
    merge(entry, fields);
    emit(line.severity, logEntry(line.severity, line.message, entry));
  } catch {
    failedWrites++;
  }
}

/**
 * The trace id of the current request or job as a Pub/Sub message attribute (`traceparent`,
 * W3C format; LG-4 A), for a job this work puts on a queue. Empty outside any event.
 */
export function traceAttributes(): Record<string, string> {
  const event = currentEvent();
  return event ? { traceparent: traceparentFor(event.traceId) } : {};
}

/** Times one SurrealDB query or function into the current event's `db` group. */
export async function timeDb<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const event = currentEvent();
  if (!event) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    event.recordDb(name, performance.now() - start);
  }
}

/**
 * Times one outside call (`clerk`, `bunny`, `stripe`, `resend`) into the current event's
 * `external.<name>`, with the answer's HTTP status (a `Response`'s), or `error` if it threw.
 */
export async function timeExternal<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const event = currentEvent();
  if (!event) return work();
  const start = performance.now();
  let status: number | string | undefined;
  try {
    const result = await work();
    const s = (result as { status?: unknown } | null)?.status;
    if (typeof s === 'number') status = s;
    return result;
  } catch (err) {
    status =
      err instanceof Error && /abort|timeout/i.test(err.name)
        ? 'timeout'
        : 'error';
    throw err;
  } finally {
    event.recordExternal(name, performance.now() - start, status);
  }
}

/** A `fetch` that times every call as `external.<name>`. */
export function timedFetch(
  name: string,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => timeExternal(name, () => fetcher(input, init));
}

/** Who searched: written only as keyed hashes with the search-only key. */
export interface Searcher {
  ip?: string;
  email?: string;
  userId?: string;
  /** Plain: shared by many people. */
  role?: string;
  /** Plain (bot detection, Joel 23 Nov). */
  userAgent?: string;
}

export interface SearchEventInput {
  service: ServiceFields | string;
  /** The route template (`/v1/stories`), never the address with its terms. */
  route?: string;
  durationMs: number;
  outcome: Outcome;
  action?: string;
  search: {
    q?: string;
    tags?: string[];
    filters?: Record<string, unknown>;
    result_count?: number;
  };
  who: Searcher;
  db?: {
    calls: number;
    total_ms: number;
    slowest?: { name: string; ms: number };
  };
}

/**
 * The separate search event (LG-2g A, Joel 24 Nov 2026): the terms, filters, result count,
 * timing and outcome plain; who searched only as `hs1:` hashes (`client.ip_hash`,
 * `user.email_hash`, `user.id_hash`), never plain, not on error. No `ref`, no trace field, no
 * session or token hash, no account age: nothing joins it to the request's own event.
 */
export function searchEntry(
  input: SearchEventInput,
  now: Date = new Date(),
): { severity: Severity; entry: Record<string, unknown> } {
  const { who } = input;
  const kind = clientKind(who.userAgent);
  const client: Record<string, unknown> = {
    ip_hash: who.ip ? searchHash(who.ip) : undefined,
    user_agent: who.userAgent,
    browser: kind.browser,
    os: kind.os,
    device: kind.device,
  };
  const user: Record<string, unknown> = {
    id_hash: who.userId ? searchHash(who.userId) : undefined,
    role: who.role,
    email_hash: who.email ? searchHash(who.email) : undefined,
  };
  const fields: Record<string, unknown> = {
    event: 'search',
    service:
      typeof input.service === 'string'
        ? serviceFields(input.service)
        : input.service,
  };
  merge(fields, {
    http: { route: input.route, duration_ms: input.durationMs },
    client,
    user,
    action: input.action ?? 'story.search',
    outcome: input.outcome,
    search: input.search,
    db: input.db,
    debug: { plain_content: false },
  });
  for (const group of ['client', 'user'] as const) {
    if (isObject(fields[group]) && !Object.keys(fields[group]).length) {
      delete fields[group];
    }
  }
  const count = input.search.result_count;
  const message = `search ${count ?? '?'} results in ${input.durationMs} ms`;
  const severity: Severity = input.outcome === 'error' ? 'ERROR' : 'INFO';
  return { severity, entry: logEntry(severity, message, fields, now) };
}

/** Writes the search event. Never throws. */
export function writeSearchEvent(input: SearchEventInput): void {
  try {
    const { severity, entry } = searchEntry(input);
    emit(severity, entry);
  } catch {
    failedWrites++;
  }
}

/**
 * The immediate unexpected-error line (Error Reporting reads `stack_trace`), with the request's
 * `ref`. Written the moment the error is caught; the wide event follows when the request ends.
 */
export function writeErrorLine(
  err: unknown,
  { ref, traceId }: { ref?: string; traceId?: string } = {},
): void {
  try {
    const type = err instanceof Error ? err.name : 'Error';
    const trace = traceId ? cloudTrace(traceId) : undefined;
    const entry = logEntry('ERROR', `${type}: unexpected error`, {
      event: 'error',
      ...(ref ? { ref } : {}),
      ...(trace ? { [TRACE_FIELD]: trace } : {}),
      stack_trace: err instanceof Error ? err.stack : String(err),
    });
    emit('ERROR', entry);
  } catch {
    failedWrites++;
  }
}
