import { apiPublicReadUrl } from './config';

describe('apiPublicReadUrl', () => {
  const saved = process.env['API_PUBLIC_READ_URL'];
  afterEach(() => {
    if (saved === undefined) delete process.env['API_PUBLIC_READ_URL'];
    else process.env['API_PUBLIC_READ_URL'] = saved;
  });

  it('returns the base URL without a trailing slash', () => {
    process.env['API_PUBLIC_READ_URL'] =
      'https://api-public-read-abc.a.run.app/';
    expect(apiPublicReadUrl()).toBe('https://api-public-read-abc.a.run.app');
  });

  it('fails clearly when it is not set', () => {
    delete process.env['API_PUBLIC_READ_URL'];
    expect(() => apiPublicReadUrl()).toThrow('API_PUBLIC_READ_URL is not set');
  });
});
