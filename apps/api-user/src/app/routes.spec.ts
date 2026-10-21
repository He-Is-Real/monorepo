import {
  contractRequiredRoles,
  listAppRolePolicies,
  useTestClerkEnv,
} from '@heisreal/auth/testing';
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

/**
 * D1: every api-user route declares its minimum role (@RequiresRole) or @NoRoleRequired(reason);
 * the app refuses to start otherwise. The declared minimum must equal the contract's
 * `x-required-role` (api-user.yaml, the source of truth), read from the spec itself.
 */
describe('api-user routes and their role policy (D1)', () => {
  it('every route declares a role policy, listed here', async () => {
    const { routes, problems } = await listAppRolePolicies(AppModule);
    expect(problems).toEqual([]);
    expect(routes).toEqual([
      'GET /health: no role required (health probe for Cloud Run and uptime checks)',
      'GET /v1/account/consents: role User+',
      'POST /v1/account/consents: role User+',
      'POST /v1/account/consents/:type/withdraw: role User+',
    ]);
  });

  it('every route is in the contract, with the contract’s x-required-role', async () => {
    const { minimums } = await listAppRolePolicies(AppModule);
    const contract = contractRequiredRoles('api-user.yaml');
    for (const route of Object.keys(minimums)) {
      expect([route, route in contract]).toEqual([route, true]);
    }
    expect(minimums).toEqual(
      Object.fromEntries(Object.keys(minimums).map((r) => [r, contract[r]])),
    );
  });
});
