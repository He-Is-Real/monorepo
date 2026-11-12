import type { Request } from 'express';
import { canonicalIp } from '@heisreal/http';
import { senderIp } from './sender-ip';

const req = (forwarded: string | undefined, peer = '10.0.0.1') =>
  ({
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    socket: { remoteAddress: peer },
  }) as unknown as Request;

describe('senderIp: the address the block list keeps', () => {
  it("takes X-Forwarded-For's last entry, the one Google's front end appended", () => {
    expect(senderIp(req('203.0.113.7'))).toBe('203.0.113.7');
    // Whatever the client put before it is ignored: it can say anything.
    expect(senderIp(req('198.51.100.1, 203.0.113.7'))).toBe('203.0.113.7');
  });

  it("falls back to the socket's peer with no header", () => {
    expect(senderIp(req(undefined, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
  });

  it('writes each address one way, so the same address always matches', () => {
    expect(canonicalIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(canonicalIp('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(canonicalIp('not-an-ip')).toBeUndefined();
    expect(canonicalIp('999.1.1.1')).toBeUndefined();
  });
});
