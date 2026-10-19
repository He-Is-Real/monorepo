import { runInThisContext } from 'node:vm';

/**
 * Jest-only fix. Jest's node environment hands the test sandbox the host's Uint8Array and
 * ArrayBuffer but its own Uint32Array & co, so `Uint32Array.of(…).buffer instanceof ArrayBuffer`
 * is false. surrealdb.js builds UUIDs that way and its CBOR encoder then can't encode them, so
 * any request carrying a Uuid (e.g. newSession()'s session id) never completes. Not an issue
 * outside Jest. Align every binary constructor with the host realm.
 */
const g = globalThis as unknown as Record<string, unknown>;
for (const name of [
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]) {
  g[name] = runInThisContext(name);
}
