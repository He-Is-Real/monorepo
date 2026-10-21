/**
 * @jest-environment node
 */
import { GET } from './route';

describe('GET /health', () => {
  it('reports the service as up, uncached', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', service: 'web' });
  });
});
