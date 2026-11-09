import { idTokens, type TokenClient } from './google';

/** A Google ID token's shape: only its expiry is read. */
const token = (exp: number) =>
  `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

describe("the worker's sign-in for ID tokens", () => {
  it('tries once more when a sign-in fails (a renewal swapped the certificate mid-read)', async () => {
    const good = token(Math.floor(Date.now() / 1000) + 3600);
    let calls = 0;
    const client: TokenClient = {
      request: async <T>() => {
        calls += 1;
        if (calls === 1) throw new Error('key values mismatch');
        return { data: { token: good } as T };
      },
    };
    const idToken = idTokens(
      {},
      'media-worker@p.iam.gserviceaccount.com',
      client,
    );
    await expect(idToken('https://writer.example')).resolves.toBe(good);
    expect(calls).toBe(2);
  });

  it('gives up after the second failure', async () => {
    let calls = 0;
    const client: TokenClient = {
      request: async () => {
        calls += 1;
        throw new Error('unavailable');
      },
    };
    const idToken = idTokens(
      {},
      'media-worker@p.iam.gserviceaccount.com',
      client,
    );
    await expect(idToken('https://writer.example')).rejects.toThrow(
      'unavailable',
    );
    expect(calls).toBe(2);
  });
});
