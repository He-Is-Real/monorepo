import { ipKeyGenerator } from 'express-rate-limit';

/**
 * A sliding-window request counter kept in memory (RL-6: per running copy, nothing stored: no
 * database, Redis or edge service, and no caller's address is written anywhere;
 * Joel 2026-11-21: "use sliding window"). Framework-free: the APIs plug it into
 * express-rate-limit as its `store` (`SlidingWindowStore`), and web's proxy uses it directly.
 *
 * How it counts: each caller has the count of the current fixed window and the one before. The
 * count "in the last `windowMs`" is the current count plus the previous one weighted by how much
 * of the previous window still lies inside the last `windowMs`. That is the usual approximate
 * sliding window: two numbers per caller instead of a timestamp per request, and no burst
 * allowed at a window boundary (a caller who used everything just before it still counts it
 * just after). Refused requests count too, so a caller who keeps trying stays refused.
 *
 * Memory is bounded: at most `maxKeys` callers (the least recently seen goes first; it only
 * forgets that caller's count), and callers whose counts have run out are dropped as new
 * requests arrive. No timers.
 */
export class SlidingWindowCounter {
  /** Callers by key, least recently seen first (a Map keeps insertion order). */
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor({
    windowMs,
    maxKeys = DEFAULT_MAX_KEYS,
    now = Date.now,
  }: {
    windowMs: number;
    maxKeys?: number;
    now?: () => number;
  }) {
    if (!(windowMs > 0)) throw new Error('windowMs must be positive');
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** Counts one request by `key`; returns the caller's count in the last window, this one included. */
  hit(key: string): number {
    const at = this.now();
    const entry = this.current(key, at) ?? {
      start: this.windowStart(at),
      count: 0,
      previous: 0,
    };
    entry.count += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.dropStale(at);
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return this.weighted(entry, at);
  }

  /** The caller's count in the last window, without counting a request. */
  peek(key: string): number {
    const at = this.now();
    const entry = this.current(key, at);
    return entry ? this.weighted(entry, at) : 0;
  }

  /** Takes back one request by `key` (express-rate-limit's `decrement`). */
  undo(key: string): void {
    const entry = this.current(key, this.now());
    if (entry && entry.count > 0) entry.count -= 1;
  }

  /** When the window the caller's newest request is in ends (ms since the epoch). */
  windowEnd(key: string): number {
    const at = this.now();
    return (
      (this.current(key, at)?.start ?? this.windowStart(at)) + this.windowMs
    );
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** How many callers are remembered (tests). */
  get size(): number {
    return this.entries.size;
  }

  private windowStart(at: number): number {
    return at - (at % this.windowMs);
  }

  /** The entry for `key`, moved on to the window `at` is in; undefined if none or run out. */
  private current(key: string, at: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const start = this.windowStart(at);
    if (start === entry.start) return entry;
    if (start - entry.start === this.windowMs) {
      entry.previous = entry.count;
    } else {
      // Two or more windows ago (or a clock that went back): nothing left to count.
      entry.previous = 0;
    }
    entry.count = 0;
    entry.start = start;
    if (entry.previous === 0) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private weighted(entry: Entry, at: number): number {
    const elapsed = (at - entry.start) / this.windowMs;
    return entry.count + entry.previous * (1 - elapsed);
  }

  /** Drops a few of the least recently seen callers whose counts have run out. */
  private dropStale(at: number): void {
    let checked = 0;
    for (const [key, entry] of this.entries) {
      if (checked++ >= STALE_CHECKS_PER_HIT) return;
      if (at - entry.start < 2 * this.windowMs) return;
      this.entries.delete(key);
    }
  }
}

interface Entry {
  /** Start of the window `count` belongs to. */
  start: number;
  count: number;
  /** The count of the window before `start`. */
  previous: number;
}

/** Callers remembered per counter: about 100 bytes each, so about 5 MB at most. */
export const DEFAULT_MAX_KEYS = 50_000;
const STALE_CHECKS_PER_HIT = 4;

/**
 * The caller key for an IP address: express-rate-limit's own grouping (8.2.2 or later, past
 * CVE-2026-30827), so web and the APIs group the same way: an IPv4 address (an IPv4-mapped IPv6
 * address counts as its IPv4 address) is itself; an IPv6 address counts as its /56 network, the
 * library's default, so one home or phone can't get a fresh allowance by changing address inside
 * its block.
 */
export function callerKey(ip: string): string {
  return ipKeyGenerator(ip);
}

/**
 * Whether rate limits are on: where Cloud Run runs the service. Cloud Run itself sets `K_SERVICE`
 * on every service (a reserved name: neither we nor a caller can set or clear it there), so
 * deployed copies always count. Local runs, the integration suites and web's e2e servers don't
 * have it, so their many requests from one address never trip a limit; the rate-limit tests turn
 * limits on themselves.
 */
export function rateLimitsActive(
  env: Record<string, string | undefined> | undefined = globalThis.process?.env,
): boolean {
  return !!env?.['K_SERVICE'];
}
