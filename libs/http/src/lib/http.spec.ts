import { Controller, Get, HttpStatus, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { corsOptions } from './cors';
import { ProblemException, ProblemFilter } from './problem.filter';

describe('corsOptions', () => {
  it('allows exactly the listed origins, without credentials', () => {
    const o = corsOptions(
      'https://web-abc-nw.a.run.app, http://localhost:3000',
    );
    expect(o.origin).toEqual([
      'https://web-abc-nw.a.run.app',
      'http://localhost:3000',
    ]);
    expect(o.credentials).toBe(false);
    expect(o.exposedHeaders).toEqual(['ETag', 'Location']);
  });

  it('allows no browser origin when unset', () => {
    expect(corsOptions('').origin).toBe(false);
  });

  it.each(['*', 'https://web.example/path', 'http://web.example', 'not a url'])(
    'refuses %p',
    (value) => {
      expect(() => corsOptions(value)).toThrow('CORS_ALLOWED_ORIGINS');
    },
  );
});

@Controller()
class Probe {
  @Get('missing')
  missing() {
    throw new ProblemException(
      HttpStatus.NOT_FOUND,
      'story_not_found',
      'Story not found',
    );
  }
  @Get('plain')
  plain() {
    throw new NotFoundException();
  }
  @Get('boom')
  boom() {
    throw new Error('secret testimony text');
  }
}

describe('ProblemFilter', () => {
  let url: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [Probe],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    close = () => app.close();
  });
  afterAll(() => close());

  it('answers a ProblemException as application/problem+json with its code', async () => {
    const res = await fetch(`${url}/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(
      /^application\/problem\+json/,
    );
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Story not found',
      status: 404,
      code: 'story_not_found',
    });
  });

  it('turns Nest exceptions and unknown routes into problems', async () => {
    expect(await (await fetch(`${url}/plain`)).json()).toMatchObject({
      status: 404,
      type: 'about:blank',
    });
    const unknown = await fetch(`${url}/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toMatch(/problem\+json/);
  });

  it('never echoes an unknown error’s message', async () => {
    const res = await fetch(`${url}/boom`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
    });
  });
});
