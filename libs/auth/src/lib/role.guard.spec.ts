import {
  Controller,
  Get,
  Global,
  type INestApplication,
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
  describe('enforcing declared minimums', () => {
    let app: INestApplication;
    let url: string;
    beforeAll(async () => {
      app = await boot([StaffController]);
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    });
    afterAll(() => app.close());

    const get = (path: string, role?: string) =>
      fetch(`${url}${path}`, { headers: role ? { 'x-role': role } : {} });

    it('lets the minimum role and above through', async () => {
      expect((await get('/v1/queue', 'Moderator')).status).toBe(200);
      expect((await get('/v1/queue', 'SuperAdmin')).status).toBe(200);
      expect((await get('/v1/dpa', 'SuperAdmin')).status).toBe(200);
    });

    it('answers 403 role_required below it', async () => {
      const res = await get('/v1/queue', 'User');
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'role_required',
        requiredRole: 'Moderator',
      });
      expect((await get('/v1/dpa', 'Admin')).status).toBe(403);
    });

    it('answers 403 for an unknown or missing role claim, 401 when not signed in', async () => {
      expect((await get('/v1/queue', 'moderator')).status).toBe(403);
      expect((await get('/v1/queue', 'none')).status).toBe(403);
      expect((await get('/v1/queue')).status).toBe(401);
    });

    it('lets @NoRoleRequired routes through without signing in', async () => {
      expect((await get('/v1/open')).status).toBe(200);
    });
  });

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
