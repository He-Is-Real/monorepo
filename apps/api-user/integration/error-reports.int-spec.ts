import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';

import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk } from '@heisreal/auth/testing';
import { SURREAL } from '@heisreal/database';
import { TestDatabase } from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { AppModule } from '../src/app/app.module';
import { apiUserWideEvents } from '../src/app/wide-events';

/**
 * The browser's error reports (LG-1c, LG-9a; `POST /v1/error-reports`) through api-user's real
 * AppModule: no sign-in, one `event: "error_report"` log line with the person's reference, and
 * anything but `{ reference, route, kind }` refused without a line. Anyone may call it, so its
 * body is never logged, not even on a refusal (an exception to LG-9b, Codex review of #286): the
 * request's wide event keeps only the failed field names and checks.
 */
describe('api-user error reports', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    t = await TestDatabase.create();
    const clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_user'))
      .overrideProvider(CLERK_CONFIG)
      .useValue(
        parseClerkConfig({
          issuer: clerk.issuer,
          publicKeyPem: clerk.publicKeyPem,
          authorizedParties: clerk.authorizedParty,
        }),
      )
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(apiUserWideEvents());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });
  beforeEach(() => {
    lines.length = 0;
    const keep = (line: unknown) => {
      if (typeof line === 'string' && line.startsWith('{'))
        lines.push(JSON.parse(line) as Record<string, unknown>);
    };
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'error').mockImplementation(keep);
  });
  afterEach(() => vi.restoreAllMocks());

  const send = (body: unknown, trace?: string) =>
    fetch(`${url}/v1/error-reports`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
        ...(trace
          ? { traceparent: `00-${trace.replace(/-/g, '')}-0123456789abcdef-01` }
          : {}),
      },
      body: JSON.stringify(body),
    });
  const reports = () => lines.filter((l) => l['event'] === 'error_report');
  /** The request's wide event with this trace, once written (after the answer has gone). */
  const requestEvent = async (trace: string) => {
    const find = () =>
      lines.find((l) => l['event'] === 'request' && l['ref'] === trace);
    await vi.waitFor(() => expect(find()).toBeDefined());
    return find() ?? {};
  };

  it('writes one line with the reference, the page and the kind, signed out', async () => {
    const reference = '0193a7c4-5e19-7d03-b2c4-91f0e7a6d258';
    const res = await send({ reference, route: '/share', kind: 'no_answer' });
    expect(res.status).toBe(204);
    expect(reports()).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        ref: reference,
        report: { route: '/share', kind: 'no_answer' },
        client: expect.objectContaining({ browser: 'Firefox 140' }),
      }),
    ]);
  });

  it('refuses anything but a reference, a path and a known kind', async () => {
    for (const body of [
      { reference: 'not-a-uuid', route: '/', kind: 'browser_crash' },
      // A UUID v4 isn't one the browser makes.
      {
        reference: '3bb2b3aa-ef40-4364-8e17-8e519e0e9580',
        route: '/',
        kind: 'browser_crash',
      },
      {
        reference: '0193a7c4-5e19-7d03-b2c4-91f0e7a6d258',
        route: '/stories?q=hope',
        kind: 'browser_crash',
      },
      {
        reference: '0193a7c4-5e19-7d03-b2c4-91f0e7a6d258',
        route: '/',
        kind: 'server_error',
      },
      {
        reference: '0193a7c4-5e19-7d03-b2c4-91f0e7a6d258',
        route: '/',
        kind: 'browser_crash',
        detail: 'TypeError: x is undefined',
      },
    ]) {
      const res = await send(body);
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
    expect(reports()).toEqual([]);
  });

  it('never logs what a refused report said, only which checks failed', async () => {
    const said = 'Call 0800 000 000 now: free money';
    const unknownField = '0193a7c4-5e19-7d03-b2c4-91f0e7a6d201';
    const res = await send(
      {
        reference: '0193a7c4-5e19-7d03-b2c4-91f0e7a6d258',
        route: '/',
        kind: 'browser_crash',
        [said]: said,
      },
      unknownField,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('free money');
    const badValue = '0193a7c4-5e19-7d03-b2c4-91f0e7a6d202';
    const res2 = await send(
      { reference: said, route: '/', kind: 'no_answer' },
      badValue,
    );
    expect(res2.status).toBe(400);
    const events = [
      await requestEvent(unknownField),
      await requestEvent(badValue),
    ];
    expect(JSON.stringify(lines)).not.toContain('free money');
    expect(events.map((e) => [e['outcome'], e['input'], e['request']])).toEqual(
      [
        [
          'input_refused',
          { failed_fields: [''], failed_checks: ['invalid'] },
          undefined,
        ],
        [
          'input_refused',
          { failed_fields: ['reference'], failed_checks: ['invalid'] },
          undefined,
        ],
      ],
    );
  });

  it('never logs it either when the request names the whole address (absolute form)', async () => {
    const trace = '0193a7c4-5e19-7d03-b2c4-91f0e7a6d203';
    const body = JSON.stringify({
      reference: 'free money',
      route: '/',
      kind: 'no_answer',
    });
    const status = await new Promise<number | undefined>((done, fail) => {
      const req = httpRequest(
        url,
        {
          method: 'POST',
          // The request line carries the whole address, which Express routes like the path.
          path: `${url}/v1/error-reports`,
          headers: {
            'content-type': 'application/json',
            traceparent: `00-${trace.replace(/-/g, '')}-0123456789abcdef-01`,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => done(res.statusCode));
        },
      );
      req.on('error', fail);
      req.end(body);
    });
    expect(status).toBe(400);
    const event = await requestEvent(trace);
    expect(event['input']).toEqual({
      failed_fields: ['reference'],
      failed_checks: ['invalid'],
    });
    expect(JSON.stringify(lines)).not.toContain('free money');
  });
});
