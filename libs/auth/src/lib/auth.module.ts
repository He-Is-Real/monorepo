import {
  type DynamicModule,
  Global,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { listRoutes } from '@heisreal/consent';
import { CLERK_CONFIG, clerkConfigFromEnv } from './clerk-config';
import { describeRolePolicy, RoleGuard } from './role.guard';

/**
 * Clerk sign-in for api-user and api-admin (task 0.5, D1, D27). Provides the verification
 * settings ({@link CLERK_CONFIG}, read and checked at startup) and installs the global
 * {@link RoleGuard}: every route must carry `@RequiresRole` or `@NoRoleRequired`
 * (`@heisreal/roles`), or the application refuses to start. Pass the service's authenticator to `ConsentModule.forRoot`:
 * `ApiUserAuthenticator` or `ApiAdminAuthenticator`.
 */
@Global()
@Module({})
export class ClerkAuthModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(ClerkAuthModule.name);

  constructor(private readonly discovery: DiscoveryService) {}

  static forRoot(): DynamicModule {
    return {
      module: ClerkAuthModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: CLERK_CONFIG, useFactory: clerkConfigFromEnv },
        { provide: APP_GUARD, useClass: RoleGuard },
      ],
      exports: [CLERK_CONFIG],
    };
  }

  onApplicationBootstrap(): void {
    const policies = listRolePolicies(this.discovery);
    const bad = policies.filter((p) => p.problem);
    if (bad.length) {
      throw new Error(
        `Every route needs a valid role policy (D1):\n` +
          bad.map((p) => `  ${p.line}`).join('\n'),
      );
    }
    this.logger.log(`Role policy set on all ${policies.length} routes`);
  }
}

/** The role-listing check for an app's routes spec, like `listAppRoutePolicies` for consent. */
export function listRolePolicies(discovery: DiscoveryService) {
  return listRoutes(discovery).map(describeRolePolicy);
}
