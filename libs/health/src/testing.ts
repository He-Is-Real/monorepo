import type { Type } from '@nestjs/common';
import { SURREAL } from '@heisreal/database';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { Test } from '@nestjs/testing';

/**
 * Boots a service's real AppModule with SurrealDB and Secret Manager stubbed
 * out, and calls its `GET /health`. Proves the module wiring, not the database.
 */
export async function getHealth(
  appModule: Type,
): Promise<{ status: number; body: unknown }> {
  const moduleRef = await Test.createTestingModule({ imports: [appModule] })
    .overrideProvider(SURREAL)
    .useValue({ query: async () => [true], close: async () => true })
    .overrideProvider(SECRET_MANAGER_CLIENT)
    .useValue({})
    .overrideProvider(SECRETS_PROJECT)
    .useValue('test-project')
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`${await app.getUrl()}/health`);
    return { status: res.status, body: await res.json() };
  } finally {
    await app.close();
  }
}
