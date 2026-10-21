import { listAppRoutePolicies } from '@heisreal/consent/testing';
import { AppModule } from './app.module';

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
