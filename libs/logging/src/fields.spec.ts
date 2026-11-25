import { startEvent, writeSearchEvent } from './event';
import { LOG_FIELDS, MAX_LOG_FIELDS } from './fields';
import { addLogSink } from './index';

/** `{ a: { b: 1 } }` → `a.b`; an array is one field (as Axiom stores it). */
function flatten(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe("the logs' field budget (Axiom keeps 256 per dataset)", () => {
  it(`lists at most ${MAX_LOG_FIELDS} distinct fields`, () => {
    expect(new Set(LOG_FIELDS).size).toBe(LOG_FIELDS.length);
    expect(LOG_FIELDS.length).toBeLessThanOrEqual(MAX_LOG_FIELDS);
  });

  it("lists every field the library's own events write", () => {
    const entries: Record<string, unknown>[] = [];
    const remove = addLogSink({
      write: (_, entry) => void entries.push(entry),
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const event = startEvent('request', 'api-user');
      event.recordDb('story.get', 3);
      event.recordExternal('bunny', 12, 200);
      event.longText('request.body', '{}');
      event.sensitive('user.session_hash', 'sess_1');
      event.fail({ type: 'Error', code: 'x', retriable: false, message: 'm' });
      event.write();
      writeSearchEvent({
        service: 'api-public-read',
        route: '/v1/stories',
        durationMs: 4,
        outcome: 'ok',
        search: { q: 'hope', tags: [], result_count: 1 },
        who: { ip: '192.0.2.1', userAgent: 'Mozilla/5.0' },
      });
    } finally {
      remove();
      vi.restoreAllMocks();
    }
    const unknown = entries
      .flatMap((e) => flatten(e))
      .filter((f) => !LOG_FIELDS.includes(f));
    expect(unknown).toEqual([]);
  });
});
