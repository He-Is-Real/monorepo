import { createHmac } from 'node:crypto';
import {
  BunnyWebhookVerificationError,
  verifyBunnySignature,
} from './bunny-webhook';

// Bunny's recipe (https://bunny.net/docs/stream-webhook): lowercase hex HMAC-SHA256 of the exact
// body bytes, keyed with the library's read-only API key, under version v1 / hmac-sha256.
const KEY = 'a1b2c3d4-read-only-library-key';
const BODY = Buffer.from(
  '{"VideoLibraryId":789855,"VideoGuid":"0f0e0d0c-0b0a-4908-8706-000000000001","Status":3,"EventId":"evt_1","Timestamp":"2026-11-06T10:00:00Z"}',
);
const sign = (key: string, body: Buffer) =>
  createHmac('sha256', key).update(body).digest('hex');
const SIGNED = {
  signature: sign(KEY, BODY),
  version: 'v1',
  algorithm: 'hmac-sha256',
};

describe('verifyBunnySignature (Bunny Stream webhooks)', () => {
  it('accepts a body signed with the read-only key', () => {
    expect(() => verifyBunnySignature(KEY, SIGNED, BODY)).not.toThrow();
  });

  it.each([
    [
      'another body',
      {
        body: Buffer.from(BODY.toString().replace('"Status":3', '"Status":5')),
      },
    ],
    [
      'the same JSON re-serialised',
      {
        body: Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 1)),
      },
    ],
    ['another library’s key', { key: 'another-library-read-only-key' }],
    [
      'the signature in upper case',
      { headers: { signature: SIGNED.signature.toUpperCase() } },
    ],
    ['no signature', { headers: { signature: undefined } }],
    [
      'a short signature',
      { headers: { signature: SIGNED.signature.slice(2) } },
    ],
    ['another signature version', { headers: { version: 'v2' } }],
    [
      'anything, while the key is empty',
      { key: '', headers: { signature: sign('', BODY) } },
    ],
    ['another algorithm', { headers: { algorithm: 'hmac-sha1' } }],
  ])(
    'refuses %s',
    (_, change: { body?: Buffer; key?: string; headers?: object }) => {
      expect(() =>
        verifyBunnySignature(
          change.key ?? KEY,
          { ...SIGNED, ...change.headers },
          change.body ?? BODY,
        ),
      ).toThrow(BunnyWebhookVerificationError);
    },
  );
});
