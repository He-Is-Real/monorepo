import { isIP } from 'node:net';

/**
 * An IP address in the one form the block list keeps (G21 D, Joel 2026-11-11), so the same
 * address always matches: IPv4 dotted; IPv6 in its short lower-case form; an IPv4-mapped IPv6
 * address as plain IPv4. api-user writes a story's sender address this way and api-admin a
 * blocked one; the database checks the result is a lower-case IP address.
 */
/** `raw` in the form the block list keeps, or undefined if it isn't an IP address. */
export function canonicalIp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ip = raw.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  switch (isIP(ip)) {
    case 4:
      return ip;
    case 6: {
      const short = new URL(`http://[${ip}]`).hostname.slice(1, -1);
      const v4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(short);
      if (v4) {
        const [hi, lo] = [parseInt(v4[1], 16), parseInt(v4[2], 16)];
        return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
      }
      return short;
    }
    default:
      return undefined;
  }
}
