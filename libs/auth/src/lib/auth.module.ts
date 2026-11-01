import {
  type DynamicModule,
  Global,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type Type,
} from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { CLERK_CONFIG, clerkConfigFromEnv } from './clerk-config';
import {
  PERSON_AUTHENTICATOR,
  type PersonAuthenticator,
  PersonSessions,
  SignInUnavailable,
} from './person';
import { describeRolePolicy, RoleGuard } from './role.guard';
import { listRoutes } from './routes';

export interface ClerkAuthModuleOptions {
  /**
   * Verifies the caller: `ApiUserAuthenticator` or `ApiAdminAuthenticator`. Default: nobody can
   * sign in (`SignInUnavailable`), so routes that need a role answer `401`.
   */
  authenticator?: Type<PersonAuthenticator>;
}

/**
 * Clerk sign-in for api-user and api-admin (task 0.5, D1, D27). Provides the verification
 * settings ({@link CLERK_CONFIG}, read and checked at startup), the service's authenticator and
 * {@link PersonSessions} (the person's own database session, D27), and installs the global
 * {@link RoleGuard}: every route must carry `@RequiresRole` or `@NoRoleRequired`
 * (`@heisreal/roles`), or the application refuses to start. Requires `DatabaseModule`.
 */
@Global()
@Module({})
export class ClerkAuthModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(ClerkAuthModule.name);

  constructor(private readonly discovery: DiscoveryService) {}

  static forRoot(options: ClerkAuthModuleOptions = {}): DynamicModule {
    return {
      module: ClerkAuthModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: CLERK_CONFIG, useFactory: clerkConfigFromEnv },
        {
          provide: PERSON_AUTHENTICATOR,
          useClass: options.authenticator ?? SignInUnavailable,
        },
        PersonSessions,
        { provide: APP_GUARD, useClass: RoleGuard },
      ],
      exports: [CLERK_CONFIG, PersonSessions],
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

/** The role-listing check for an app's routes spec and the startup check. */
export function listRolePolicies(discovery: DiscoveryService) {
  return listRoutes(discovery).map(describeRolePolicy);
}
