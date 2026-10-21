import {
  Controller,
  Get,
  Global,
  type INestApplication,
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
import { NoRoleRequired, RequiresRole } from './role.guard';
import { hasRole, ROLES } from './roles';

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

async function boot(
  rolePolicy: 'required' | 'optional',
  controllers: (new () => object)[],
) {
  @Module({ controllers })
  class Routes {}
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeDatabaseModule,
      ClerkAuthModule.forRoot({ rolePolicy }),
      ConsentModule.forRoot({ authenticator: HeaderAuthenticator }),
      Routes,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  return app;
}

describe('roles', () => {
  it('are ordered from least to most privileged', () => {
    expect(ROLES).toEqual([
      'Viewer',
      'User',
      'Moderator',
      'Admin',
      'SuperAdmin',
    ]);
    expect(hasRole('Admin', 'Moderator')).toBe(true);
    expect(hasRole('Moderator', 'Moderator')).toBe(true);
    expect(hasRole('User', 'Moderator')).toBe(false);
  });

  it('refuse an unknown minimum role at decoration time', () => {
    expect(() => RequiresRole('Owner' as never)).toThrow('unknown role');
  });
});

describe('RoleGuard', () => {
  describe('where every route must declare a role (api-admin)', () => {
    let app: INestApplication;
    let url: string;
    beforeAll(async () => {
      app = await boot('required', [StaffController]);
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

  it('refuses to start when a route declares no role policy (api-admin)', async () => {
    const app = await boot('required', [StaffController, UndeclaredController]);
    await expect(app.init()).rejects.toThrow(
      'GET /plain (UndeclaredController.plain): has neither @RequiresRole nor @NoRoleRequired',
    );
    await app.close();
  });

  it('lets undeclared routes through where roles are optional (api-user), and still enforces declared ones', async () => {
    const app = await boot('optional', [StaffController, UndeclaredController]);
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    try {
      expect((await fetch(`${url}/plain`)).status).toBe(200);
      expect(
        (await fetch(`${url}/v1/queue`, { headers: { 'x-role': 'User' } }))
          .status,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
