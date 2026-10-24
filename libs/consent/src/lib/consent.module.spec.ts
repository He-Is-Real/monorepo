import { Controller, Get, Global, Module, Param, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import type { Request } from 'express';
import { ConsentChecker } from './consent-checker';
import { NoConsentRequired, RequiresConsent } from './consent.decorators';
import { ConsentModule } from './consent.module';
import { CONSENT_REQUIRED } from './consent.types';
import type { AuthenticatedPerson, PersonAuthenticator } from './person';
import { PersonSessions } from './person';

@Controller('v1')
class TestController {
  @Get('open')
  @NoConsentRequired('test route without personal data')
  open() {
    return { ok: true };
  }

  @Post('stories')
  @RequiresConsent(CONSENT_REQUIRED.createDraft)
  create() {
    return { ok: 'created' };
  }

  @Post('moderation/stories/:id/approve')
  @RequiresConsent(CONSENT_REQUIRED.approveStory)
  approve(@Param('id') id: string) {
    return { ok: id };
  }
}

@Controller('broken')
class UndecoratedController {
  @Get()
  oops() {
    return 'should never run';
  }
}

class FixedAuthenticator implements PersonAuthenticator {
  async authenticate(request: Request): Promise<AuthenticatedPerson> {
    return {
      clerkUserId: 'user_ann',
      token: String(request.headers['x-test-token']),
    };
  }
}

const surreal = { query: jest.fn(), close: jest.fn() };

/** Stands in for DatabaseModule (global, provides SURREAL). */
@Global()
@Module({
  providers: [{ provide: SURREAL, useValue: surreal }],
  exports: [SURREAL],
})
class FakeDatabaseModule {}

async function boot(
  controllers: (new () => object)[],
  checker: Partial<ConsentChecker>,
  authenticator?: new () => PersonAuthenticator,
) {
  @Module({ controllers })
  class Routes {}
  let builder = Test.createTestingModule({
    imports: [
      FakeDatabaseModule,
      ConsentModule.forRoot({ authenticator }),
      Routes,
    ],
  })
    .overrideProvider(ConsentChecker)
    .useValue(checker);
  if (authenticator) {
    // Stands in for the person's database session; the real one is in the integration tests.
    const auth = new authenticator();
    builder = builder.overrideProvider(PersonSessions).useValue({
      run: async (req: Request, work: (p: unknown) => Promise<unknown>) => {
        await auth.authenticate(req);
        return work({ session: 'person-session', user: 'user:ann' });
      },
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

describe('ConsentModule', () => {
  it('refuses to start when a route has no consent decorator (D21, fail closed)', async () => {
    @Module({ controllers: [TestController, UndecoratedController] })
    class Routes {}
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDatabaseModule, ConsentModule.forRoot(), Routes],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await expect(app.init()).rejects.toThrow(
      'GET /broken (UndecoratedController.oops): has neither @RequiresConsent nor @NoConsentRequired',
    );
    await app.close();
  });

  describe('the global guard', () => {
    const callerHas = jest.fn();
    const submitterHas = jest.fn();
    let app: Awaited<ReturnType<typeof boot>>['app'];
    let url: string;

    beforeAll(async () => {
      ({ app, url } = await boot(
        [TestController],
        { callerHas, submitterHas },
        FixedAuthenticator,
      ));
    });
    afterAll(() => app.close());
    beforeEach(() => jest.resetAllMocks());

    it('answers 403 without the caller’s consent, before the handler runs', async () => {
      callerHas.mockResolvedValue(false);
      const res = await fetch(`${url}/v1/stories`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'consent_required',
        consentTypes: ['special_category_religious'],
        subject: 'caller',
      });
    });

    it('checks the submitter of the story in the route, fresh on every call', async () => {
      submitterHas.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const path = `${url}/v1/moderation/stories/s1/approve`;
      expect((await fetch(path, { method: 'POST' })).status).toBe(201);
      expect((await fetch(path, { method: 'POST' })).status).toBe(403);
      expect(submitterHas).toHaveBeenCalledTimes(2);
      expect(submitterHas).toHaveBeenCalledWith('s1', [
        'special_category_religious',
        'publish',
        'age_18plus',
      ]);
    });

    it('fails closed when the check itself fails', async () => {
      callerHas.mockRejectedValue(new Error('database down'));
      const res = await fetch(`${url}/v1/stories`, { method: 'POST' });
      expect(res.status).toBe(500);
    });
  });

  it('answers 401 on consent-guarded routes without an authenticator (nobody can sign in)', async () => {
    const callerHas = jest.fn();
    const { app, url } = await boot([TestController], { callerHas });
    try {
      const res = await fetch(`${url}/v1/stories`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(callerHas).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
