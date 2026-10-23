import { HttpException } from '@nestjs/common';
import {
  type BrowseQuery,
  encodeCursor,
  parseBrowseQuery,
  refuseQueryParameters,
} from './browse.query';

/** The problem a failing parse throws. */
function problem(fn: () => unknown): {
  status: number;
  code: string;
  errors?: { pointer: string; code?: string; message: string }[];
} {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), ...(e.getResponse() as object) } as never;
  }
  throw new Error('expected a problem');
}

const AT = '2026-10-21T20:00:00.123456789Z';

describe('parseBrowseQuery', () => {
  it('defaults to the newest 20 stories', () => {
    expect(parseBrowseQuery({})).toEqual({
      q: null,
      tags: [],
      format: null,
      sort: 'latest',
      limit: 20,
      after: null,
    });
  });

  it('reads every parameter', () => {
    expect(
      parseBrowseQuery({
        q: '  healing  prayer ',
        tag: ['healing', 'answered-prayers'],
        format: 'video',
        sort: 'oldest',
        limit: '50',
      }),
    ).toMatchObject({
      q: 'healing  prayer',
      tags: ['answered-prayers', 'healing'],
      format: 'video',
      sort: 'oldest',
      limit: 50,
    });
  });

  it('sorts by relevance by default when searching, and only then', () => {
    expect(parseBrowseQuery({ q: 'hope' }).sort).toBe('relevance');
    expect(parseBrowseQuery({ q: 'hope', sort: 'latest' }).sort).toBe('latest');
    expect(
      problem(() => parseBrowseQuery({ sort: 'relevance' })),
    ).toMatchObject({
      status: 400,
      code: 'validation_failed',
      errors: [{ pointer: '/sort' }],
    });
  });

  it('treats a blank q as no search', () => {
    expect(parseBrowseQuery({ q: '   ' })).toMatchObject({
      q: null,
      sort: 'latest',
    });
  });

  it('takes one tag as a string', () => {
    expect(parseBrowseQuery({ tag: 'healing' }).tags).toEqual(['healing']);
  });

  it('drops a repeated tag', () => {
    expect(parseBrowseQuery({ tag: ['hope', 'hope'] }).tags).toEqual(['hope']);
  });

  it.each([
    [{ limit: '0' }, '/limit'],
    [{ limit: '51' }, '/limit'],
    [{ limit: '1e1' }, '/limit'],
    [{ limit: '-1' }, '/limit'],
    [{ limit: ['1', '2'] }, '/limit'],
    [{ sort: 'popular' }, '/sort'],
    [{ format: 'photo' }, '/format'],
    [{ tag: 'Healing' }, '/tag'],
    [{ tag: 'a'.repeat(61) }, '/tag'],
    [{ tag: ['a', 'b', 'c', 'd', 'e', 'f'] }, '/tag'],
    [{ q: 'x'.repeat(201) }, '/q'],
    [{ q: ['a', 'b'] }, '/q'],
    [{ q: { nested: 'object' } }, '/q'],
    [{ views: 'desc' }, '/views'],
    [{ cursor: 'x'.repeat(301) }, '/cursor'],
  ])('refuses %j (%s)', (query, pointer) => {
    const p = problem(() => parseBrowseQuery(query));
    expect(p).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(p.errors?.map((e) => e.pointer)).toContain(pointer);
    // Never echoes what was sent.
    expect(JSON.stringify(p)).not.toMatch(/xxxxxxxx|Healing|nested/);
  });

  it('lists every invalid parameter at once', () => {
    const p = problem(() => parseBrowseQuery({ limit: '0', sort: 'x' }));
    expect(p.errors?.map((e) => e.pointer).sort()).toEqual(['/limit', '/sort']);
  });

  it('counts q in characters, not UTF-16 units', () => {
    expect(parseBrowseQuery({ q: '😀'.repeat(200) }).q).toHaveLength(400);
  });
});

describe('cursors', () => {
  const base: BrowseQuery = parseBrowseQuery({ tag: 'hope', limit: '5' });

  it('round-trips the position after the last card', () => {
    const cursor = encodeCursor(base, { key: AT, id: 'seed_v01' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.length).toBeLessThanOrEqual(300);
    expect(parseBrowseQuery({ tag: 'hope', limit: '5', cursor }).after).toEqual(
      { key: AT, id: 'seed_v01' },
    );
  });

  it('works with another page size', () => {
    const cursor = encodeCursor(base, { key: AT, id: 'seed_v01' });
    expect(parseBrowseQuery({ tag: 'hope', limit: '9', cursor }).after).toEqual(
      {
        key: AT,
        id: 'seed_v01',
      },
    );
  });

  it('carries a relevance score', () => {
    const search = parseBrowseQuery({ q: 'hope' });
    const cursor = encodeCursor(search, { key: 1.2345678901234567, id: 'a1' });
    expect(parseBrowseQuery({ q: 'hope', cursor }).after).toEqual({
      key: 1.2345678901234567,
      id: 'a1',
    });
  });

  it.each([
    ['other filters', { tag: 'faith', limit: '5' }],
    ['another search', { q: 'faith', sort: 'latest' }],
    ['another sort', { tag: 'hope', sort: 'oldest' }],
  ])('refuses a cursor used with %s', (_, query) => {
    const cursor = encodeCursor(base, { key: AT, id: 'seed_v01' });
    expect(problem(() => parseBrowseQuery({ ...query, cursor }))).toMatchObject(
      {
        status: 400,
        code: 'invalid_cursor',
      },
    );
  });

  it.each([
    ['not base64url', 'not a cursor!'],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    [
      'another version',
      Buffer.from(JSON.stringify({ v: 2 })).toString('base64url'),
    ],
    [
      'a key of the wrong type',
      Buffer.from(JSON.stringify({ v: 1, f: 'x', k: [{}, 'a'] })).toString(
        'base64url',
      ),
    ],
  ])('refuses a cursor that is %s', (_, cursor) => {
    expect(problem(() => parseBrowseQuery({ cursor }))).toMatchObject({
      status: 400,
      code: 'invalid_cursor',
      errors: [{ pointer: '/cursor' }],
    });
  });

  it('refuses a forged cursor whose id or date is not one of ours', () => {
    const forge = (k: unknown[]) => {
      const real = encodeCursor(base, { key: AT, id: 'seed_v01' });
      const decoded = JSON.parse(Buffer.from(real, 'base64url').toString());
      return Buffer.from(JSON.stringify({ ...decoded, k })).toString(
        'base64url',
      );
    };
    for (const k of [
      [AT, "x' OR 1=1"],
      ['yesterday', 'seed_v01'],
      [AT, ''],
    ])
      expect(
        problem(() =>
          parseBrowseQuery({ tag: 'hope', limit: '5', cursor: forge(k) }),
        ),
      ).toMatchObject({ status: 400, code: 'invalid_cursor' });
  });
});

describe('refuseQueryParameters', () => {
  it('accepts none', () => {
    expect(() => refuseQueryParameters({})).not.toThrow();
  });
  it('refuses any', () => {
    expect(problem(() => refuseQueryParameters({ limit: '3' }))).toMatchObject({
      status: 400,
      errors: [{ pointer: '/limit' }],
    });
  });
});
