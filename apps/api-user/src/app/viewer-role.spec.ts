import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { useTestClerkEnv } from '@heisreal/auth/testing';
import { SURREAL } from '@heisreal/database';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { AppModule } from './app.module';

const clerk = useTestClerkEnv();

/**
 * Regression (#44 review round 1): a valid token with `role: "Viewer"` reached the consent
 * endpoints, whose contract minimum is User. The real AppModule now refuses it with 403
 * `role_required` before any personal query runs.
 */
describe('api-user refuses roles below the contract minimum', () => {
  let app: INestApplication;
  let url: string;
  const queries: string[] = [];

  beforeAll(async () => {
    // The service connection: knows every person (the user-row lookup), and records queries.
    // A person session must never be opened for a refused caller.
    const surreal = {
      query: (sql: string) => {
        queries.push(sql);
        return {
          json: () => ({
            responses: async () => [{ success: true, result: ['user:x'] }],
          }),
        };
      },
      newSession: jest.fn(async () => {
        throw new Error('no person session may be opened in this test');
      }),
      close: async () => true,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(surreal)
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(() => app.close());

  const call = (method: string, path: string, role?: string) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(role === undefined
          ? {}
          : {
              authorization: `Bearer ${clerk.token('user_viewer', { role })}`,
            }),
      },
      body: method === 'POST' ? JSON.stringify({}) : undefined,
    });

  it.each([
    ['GET', '/v1/account/consents'],
    ['POST', '/v1/account/consents'],
    ['POST', '/v1/account/consents/publish/withdraw'],
  ])('%s %s: Viewer gets 403 role_required', async (method, path) => {
    const res = await call(method, path, 'Viewer');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'role_required',
      requiredRole: 'User',
    });
  });

  it('answers 401 without a token', async () => {
    expect((await call('GET', '/v1/account/consents')).status).toBe(401);
  });
});
