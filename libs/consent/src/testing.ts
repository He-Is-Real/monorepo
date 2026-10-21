import type { Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { describeRoutePolicy, listRoutePolicies } from './lib/route-policies';

/**
 * The route-listing check (D21): compiles a service's real AppModule (SurrealDB and Secret
 * Manager stubbed out) and lists every registered route with its consent policy, one line
 * each. A route without exactly one consent decorator is listed with its problem, so each
 * app's spec can assert both "no problems" and the exact table (new routes show up in review).
 */
export async function listAppRoutePolicies(appModule: Type): Promise<{
  routes: string[];
  problems: string[];
}> {
  const moduleRef = await Test.createTestingModule({ imports: [appModule] })
    .overrideProvider(SURREAL)
    .useValue({ query: async () => [true], close: async () => true })
    .overrideProvider(SECRET_MANAGER_CLIENT)
    .useValue({})
    .overrideProvider(SECRETS_PROJECT)
    .useValue('test-project')
    .compile();
  try {
    const all = listRoutePolicies(moduleRef.get(DiscoveryService));
    return {
      routes: all.map(describeRoutePolicy),
      problems: all.filter((r) => r.problem).map(describeRoutePolicy),
    };
  } finally {
    await moduleRef.close();
  }
}
