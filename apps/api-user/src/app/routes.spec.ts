import { listAppRoutePolicies } from '@heisreal/consent/testing';
import { AppModule } from './app.module';

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
