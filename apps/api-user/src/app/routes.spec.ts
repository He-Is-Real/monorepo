import {
  contractRequiredRoles,
  listAppRolePolicies,
  useTestClerkEnv,
} from '@heisreal/auth/testing';
import { AppModule } from './app.module';

useTestClerkEnv();

/**
 * D1: every api-user route declares its minimum role (@RequiresRole) or @NoRoleRequired(reason);
 * the app refuses to start otherwise (app.module.spec.ts). The declared minimum must equal the contract's
 * `x-required-role` (api-user.yaml, the source of truth), read from the spec itself.
 */
describe('api-user routes and their role policy (D1)', () => {
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
