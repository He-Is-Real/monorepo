import {
  type DynamicModule,
  Global,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { ConsentChecker } from './consent-checker';
import { ConsentGuard } from './consent.guard';
import { ConsentLedger } from './consent-ledger';
import {
  PERSON_AUTHENTICATOR,
  type PersonAuthenticator,
  PersonSessions,
  SignInUnavailable,
} from './person';
import { describeRoutePolicy, listRoutePolicies } from './route-policies';

export interface ConsentModuleOptions {
  /**
   * Verifies the caller (`libs/auth`'s Clerk authenticators). Default: nobody can sign
   * in (`SignInUnavailable`), so personal routes answer `401`.
   */
  authenticator?: Type<PersonAuthenticator>;
}

/**
 * Consent foundation for api-user and api-admin (D17–D21). Installs the global fail-closed
 * `ConsentGuard`, and refuses to start the application if any route lacks a consent decorator.
 * Requires `DatabaseModule`.
 */
@Global()
@Module({})
export class ConsentModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConsentModule.name);

  constructor(private readonly discovery: DiscoveryService) {}

  static forRoot(options: ConsentModuleOptions = {}): DynamicModule {
    const authenticator: Provider = {
      provide: PERSON_AUTHENTICATOR,
      useClass: options.authenticator ?? SignInUnavailable,
    };
    return {
      module: ConsentModule,
      imports: [DiscoveryModule],
      providers: [
        authenticator,
        PersonSessions,
        ConsentChecker,
        ConsentLedger,
        { provide: APP_GUARD, useClass: ConsentGuard },
      ],
      exports: [PersonSessions, ConsentChecker, ConsentLedger],
    };
  }

  onApplicationBootstrap(): void {
    const routes = listRoutePolicies(this.discovery);
    const bad = routes.filter((r) => r.problem);
    if (bad.length) {
      throw new Error(
        `Every route needs exactly one of @RequiresConsent or @NoConsentRequired (D21):\n` +
          bad.map((r) => `  ${describeRoutePolicy(r)}`).join('\n'),
      );
    }
    this.logger.log(`Consent policy set on all ${routes.length} routes`);
  }
}
