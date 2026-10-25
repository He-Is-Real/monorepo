import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
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
  @Get('invalid')
  invalid() {
    throw new ProblemException(
      HttpStatus.BAD_REQUEST,
      'validation_failed',
      'Validation failed',
      undefined,
      [
        {
          pointer: '/limit',
          code: 'out_of_range',
          message: 'Between 1 and 50.',
        },
      ],
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
  @Get('coded')
  coded() {
    throw new ForbiddenException({
      code: 'role_required',
      message: 'This needs the Moderator role or higher',
      requiredRole: 'Moderator',
    });
  }
  @Get('uncoded')
  uncoded() {
    throw new BadRequestException('Unexpected token in "secret" at 3');
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

  it('keeps our own codes and messages, as problems', async () => {
    const res = await fetch(`${url}/coded`);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(
      /^application\/problem\+json/,
    );
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'role_required',
      detail: 'This needs the Moderator role or higher',
      requiredRole: 'Moderator',
    });
  });

  it('gives an uncoded error only its status title, never its message', async () => {
    const res = await fetch(`${url}/uncoded`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Bad request',
      status: 400,
    });
  });
});
