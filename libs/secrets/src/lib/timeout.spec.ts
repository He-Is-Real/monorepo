import { withTimeout } from './timeout';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 50, 'x')).resolves.toBe(42);
  });

  it('passes through rejections', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 50, 'x'),
    ).rejects.toThrow('boom');
  });

  it('rejects with a descriptive error when the promise hangs', async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 20, 'Reading secret'),
    ).rejects.toThrow('Reading secret timed out after 20ms');
  });
});
