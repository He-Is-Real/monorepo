/**
 * Just enough DER (ITU-T X.690) to write our own X.509 certificates and to find two fields in
 * one: the subject and the public key. Node's X509Certificate reads and verifies certificates
 * but can't make them. Everything we write is checked by reading it back with X509Certificate
 * (and, in the tests, OpenSSL's view of it through Node).
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

export const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
export const octetString = (value: Buffer) => tlv(0x04, value);
export const bool = (value: boolean) =>
  tlv(0x01, Buffer.from([value ? 0xff : 0]));
export const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'));
/** A context-specific, constructed (explicit) tag: [n] { value }. */
export const explicit = (n: number, value: Buffer) => tlv(0xa0 | n, value);
/** A context-specific, primitive (implicit) tag: [n] value-bytes. */
export const implicit = (n: number, value: Buffer) => tlv(0x80 | n, value);

/** A BIT STRING of whole bytes. */
export const bitString = (value: Buffer) =>
  tlv(0x03, Buffer.concat([Buffer.from([0]), value]));

/** A non-negative INTEGER from big-endian bytes. */
export function unsignedInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return tlv(
    0x02,
    trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) {
      chunk.unshift(0x80 | (v & 0x7f));
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5), whole seconds, UTC. */
export function time(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-11-08T12:34:56.789Z
  const digits =
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    'Z';
  const year = date.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2), 'ascii'))
    : tlv(0x18, Buffer.from(digits, 'ascii'));
}

export interface Element {
  tag: number;
  /** The whole element: tag, length and value. */
  raw: Buffer;
  /** The value only. */
  value: Buffer;
}

/** Reads one element at `offset`. Throws on anything malformed or truncated. */
export function read(buf: Buffer, offset = 0): Element {
  if (offset + 2 > buf.length) throw new Error('DER: truncated');
  const tag = buf[offset];
  let len = buf[offset + 1];
  let header = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > buf.length) {
      throw new Error('DER: bad length');
    }
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[offset + 2 + i];
    header += count;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new Error('DER: truncated');
  return {
    tag,
    raw: buf.subarray(offset, end),
    value: buf.subarray(offset + header, end),
  };
}

/** The elements inside a constructed element's value. */
export function children(value: Buffer): Element[] {
  const out: Element[] = [];
  for (let offset = 0; offset < value.length;) {
    const el = read(value, offset);
    out.push(el);
    offset += el.raw.length;
  }
  return out;
}
