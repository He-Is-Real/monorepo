import { listAppRolePolicies, useTestClerkEnv } from '@heisreal/auth/testing';
import { listAppRoutePolicies } from '@heisreal/consent/testing';
import { AppModule } from './app.module';

useTestClerkEnv();

/**
 * D21: every api-user route carries exactly one of @RequiresConsent or @NoConsentRequired.
 * This fails the build when a route has neither; the table makes every new route's choice
 * visible in review. (The app also refuses to start with an undecorated route.)
 */
describe('api-user routes and their consent policy (D21)', () => {
  it('every route has exactly one consent decorator', async () => {
    const { problems } = await listAppRoutePolicies(AppModule);
    expect(problems).toEqual([]);
  });

  it('lists every route with its policy', async () => {
    const { routes } = await listAppRoutePolicies(AppModule);
    expect(routes).toEqual([
      'GET /health: no consent required (health probe: reads no personal data)',
      'GET /v1/account/consents: no consent required (reading your own consent state and history)',
      'POST /v1/account/consents: no consent required (granting consent is how consent is obtained)',
      'POST /v1/account/consents/:type/withdraw: no consent required (withdrawing consent must be as easy as giving it (Art 7(3)))',
    ]);
  });
});

/** D1: roles are optional on api-user (any signed-in person), but any declared role is enforced. */
describe('api-user routes and their role policy (D1)', () => {
  it('lists every route with its minimum role', async () => {
    const { routes, problems } = await listAppRolePolicies(AppModule, false);
    expect(problems).toEqual([]);
    expect(routes).toEqual([
      'GET /health: no role required (health probe for Cloud Run and uptime checks)',
      'GET /v1/account/consents: any signed-in person',
      'POST /v1/account/consents: any signed-in person',
      'POST /v1/account/consents/:type/withdraw: any signed-in person',
    ]);
  });
});
