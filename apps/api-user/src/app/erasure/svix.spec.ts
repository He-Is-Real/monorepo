import { svixKey, SvixVerificationError, verifySvix } from './svix';

// Svix's own worked example (docs.svix.com, "Verifying payloads manually"), so this checks the
// recipe against Svix rather than against itself.
const KEY = svixKey('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
const BODY = Buffer.from('{"test": 2432232314}');
const SIGNED = {
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const NOW = 1614265330;

describe('verifySvix (Clerk webhooks)', () => {
  it('accepts Svix’s example, alone or among other signatures (rotation)', () => {
    expect(() => verifySvix(KEY, SIGNED, BODY, NOW)).not.toThrow();
    expect(() =>
      verifySvix(
        KEY,
        { ...SIGNED, signature: `v1,bm90IGl0 ${SIGNED.signature}` },
        BODY,
        NOW + 299,
      ),
    ).not.toThrow();
  });

  it.each([
    ['another body', { body: Buffer.from('{"test": 2432232315}') }],
    ['another message id', { headers: { id: 'msg_other' } }],
    ['a signature of another version', { headers: { signature: SIGNED.signature.replace('v1,', 'v2,') } }],
    ['no signature', { headers: { signature: undefined } }],
    ['a replay after five minutes', { now: NOW + 301 }],
    ['a timestamp from the future', { now: NOW - 301 }],
  ])('refuses %s', (_, change: { body?: Buffer; headers?: object; now?: number }) => {
    expect(() =>
      verifySvix(
        KEY,
        { ...SIGNED, ...change.headers },
        change.body ?? BODY,
        change.now ?? NOW,
      ),
    ).toThrow(SvixVerificationError);
  });

  it('refuses another endpoint’s secret, and anything that isn’t a whsec_ secret', () => {
    expect(() =>
      verifySvix(svixKey('whsec_' + Buffer.alloc(24, 1).toString('base64')), SIGNED, BODY, NOW),
    ).toThrow(SvixVerificationError);
    expect(() => svixKey('sk_test_abc')).toThrow();
    expect(() => svixKey('whsec_')).toThrow();
  });
});
