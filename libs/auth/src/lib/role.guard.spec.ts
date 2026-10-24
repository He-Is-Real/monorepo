import {
  Controller,
  Get,
  Global,
  InternalServerErrorException,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ConsentModule,
  NoConsentRequired,
  type PersonAuthenticator,
} from '@heisreal/consent';
import { SURREAL } from '@heisreal/database';
import type { Request } from 'express';
import { useTestClerkEnv } from '../testing';
import { ClerkAuthModule } from './auth.module';
import { RoleGuard } from './role.guard';
import { NoRoleRequired, RequiresRole } from '@heisreal/roles';

useTestClerkEnv();

@NoConsentRequired('role guard tests: no personal data')
@Controller('v1')
class StaffController {
  @Get('queue')
  @RequiresRole('Moderator')
  queue() {
    return { ok: 'queue' };
  }

  @Get('dpa')
  @RequiresRole('SuperAdmin')
  dpa() {
    return { ok: 'dpa' };
  }

  @Get('open')
  @NoRoleRequired('open test route without a role')
  open() {
    return { ok: 'open' };
  }
}

@NoConsentRequired('role guard tests: no personal data')
@Controller('plain')
class UndeclaredController {
  @Get()
  plain() {
    return { ok: 'plain' };
  }
}

/** The role comes from the `x-role` header; no header = not signed in. */
class HeaderAuthenticator implements PersonAuthenticator {
  async authenticate(request: Request) {
    const role = request.headers['x-role'];
    if (typeof role !== 'string') throw new UnauthorizedException();
    if (role === 'none') return { clerkUserId: 'user_x', token: 't' };
    return { clerkUserId: 'user_x', token: 't', role };
  }
}

@Global()
@Module({
  providers: [
    { provide: SURREAL, useValue: { query: jest.fn(), close: jest.fn() } },
  ],
  exports: [SURREAL],
})
class FakeDatabaseModule {}

async function boot(controllers: (new () => object)[]) {
  @Module({ controllers })
  class Routes {}
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeDatabaseModule,
      ClerkAuthModule.forRoot(),
      ConsentModule.forRoot({ authenticator: HeaderAuthenticator }),
      Routes,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  return app;
}

describe('RoleGuard', () => {
  it('refuses to start when a route declares no role policy', async () => {
    const app = await boot([StaffController, UndeclaredController]);
    await expect(app.init()).rejects.toThrow(
      'GET /plain (UndeclaredController.plain): has neither @RequiresRole nor @NoRoleRequired',
    );
    await app.close();
  });

  it('refuses an undeclared route with 500 if it is ever reached (fail closed in every service)', async () => {
    const guard = new RoleGuard({ authenticate: jest.fn() } as never);
    const context = {
      getType: () => 'http',
      getHandler: () => UndeclaredController.prototype.plain,
      getClass: () => UndeclaredController,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    };
    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
