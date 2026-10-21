import { listAppRolePolicies, useTestClerkEnv } from '@heisreal/auth/testing';
import { listAppRoutePolicies } from '@heisreal/consent/testing';
import { AppModule } from './app.module';

useTestClerkEnv();

/**
 * D21: every api-admin route carries exactly one of @RequiresConsent or @NoConsentRequired.
 * This fails the build when a route has neither; the table makes every new route's choice
 * visible in review. (The app also refuses to start with an undecorated route.)
 */
describe('api-admin routes and their consent policy (D21)', () => {
  it('every route has exactly one consent decorator', async () => {
    const { problems } = await listAppRoutePolicies(AppModule);
    expect(problems).toEqual([]);
  });

  it('lists every route with its policy', async () => {
    const { routes } = await listAppRoutePolicies(AppModule);
    expect(routes).toEqual([
      'GET /health: no consent required (health probe: reads no personal data)',
    ]);
  });
});

/**
 * D1: every api-admin route declares its minimum role (@RequiresRole, the contract's
 * x-required-role) or @NoRoleRequired(reason). The app refuses to start otherwise.
 */
describe('api-admin routes and their role policy (D1)', () => {
  it('every route declares a role policy, listed here', async () => {
    const { routes, problems } = await listAppRolePolicies(AppModule, true);
    expect(problems).toEqual([]);
    expect(routes).toEqual([
      'GET /health: no role required (health probe for Cloud Run and uptime checks)',
    ]);
  });
});
