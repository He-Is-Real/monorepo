import { MAX_ENTRY_BYTES, startEvent, traceFromHeader, uuidv7 } from './index';

describe('the reference and trace id (LG-1b A, LG-4 A)', () => {
  it('reads the browser’s traceparent; refuses invalid ones', () => {
    expect(
      traceFromHeader(
        '00-01a204cc3df67f13903075f14addacc4-00f067aa0ba902b7-01',
      ),
    ).toEqual({
      ref: '01a204cc-3df6-7f13-9030-75f14addacc4',
      traceId: '01a204cc3df67f13903075f14addacc4',
    });
    for (const bad of [
      undefined,
      '',
      'nonsense',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      'ff-01a204cc3df67f13903075f14addacc4-00f067aa0ba902b7-01',
    ]) {
      expect(traceFromHeader(bad)).toBeUndefined();
    }
  });

  it('makes UUID v7s that carry their millisecond', () => {
    const at = Date.UTC(2026, 10, 22, 14, 3, 11, 204);
    const id = uuidv7(at);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at);
  });
});

describe('the size guard (Google’s 256 KB entry limit)', () => {
  it('cuts plain long text to fit and says which field was cut', () => {
    const huge = 'é'.repeat(MAX_ENTRY_BYTES);
    const event = startEvent('job', 'media-worker');
    event.longText('transcript.text', huge).fail({ type: 'Boom' });
    const { entry } = event.build();
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(
      MAX_ENTRY_BYTES,
    );
    expect(entry).toMatchObject({
      outcome: 'error',
      transcript: { text_length: huge.length },
      debug: { plain_content: true, truncated_fields: ['transcript.text'] },
    });
  });
});

describe('cold starts (LG-12, Joel 24 Nov 2026)', () => {
  it('marks only the first request or job event a process writes as its cold start', async () => {
    vi.resetModules();
    const events = await import('./index.js');
    const written: Record<string, unknown>[] = [];
    events.LOG_SINKS.splice(0, events.LOG_SINKS.length, {
      write: (_severity, entry) => written.push(entry),
    });
    const first = events.startEvent('request', 'api-user');
    const second = events.startEvent('request', 'api-user');
    // A search event is not a request's event: it neither takes nor carries the cold start.
    events.writeSearchEvent({
      service: 'api-user',
      durationMs: 1,
      outcome: 'ok',
      search: { q: 'healing' },
      who: {},
    });
    first.write();
    second.write();
    events.startEvent('job', 'workflow').write();
    const [search, ...rest] = written;
    expect(search).not.toHaveProperty('process');
    expect(
      rest.map((e) => (e['process'] as { cold_start: boolean }).cold_start),
    ).toEqual([true, false, false]);
    const uptime = (rest[0]?.['process'] as { uptime_ms: number }).uptime_ms;
    expect(Number.isInteger(uptime)).toBe(true);
    expect(uptime).toBeGreaterThan(0);
    expect(uptime).toBeLessThanOrEqual(Math.round(process.uptime() * 1000));
  });
});
