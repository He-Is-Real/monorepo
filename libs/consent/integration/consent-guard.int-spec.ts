import {
  Controller,
  Global,
  type INestApplication,
  Module,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL, withPersonSession } from '@heisreal/database';
import {
  createPeople,
  publishDpa,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { ConsentLedger } from '../src/lib/consent-ledger';
import { RequiresConsent } from '../src/lib/consent.decorators';
import { ConsentModule } from '../src/lib/consent.module';
import {
  CONSENT_REQUIRED,
  type ConsentType,
  STATEMENT_FORM,
} from '../src/lib/consent.types';
import type {
  AuthenticatedPerson,
  PersonAuthenticator,
} from '../src/lib/person';

/**
 * D21 on the real database (Codex review of #72): the consent guard checks the caller's own
 * current consent, in their own session, for exactly the types the route requires. A route that
 * needs Art 9 consent (creating a draft) refuses a person without it and lets a person with it
 * through. The route is a test route: no page uses api-user's routes yet.
 */
@Controller('v1')
class DraftController {
  @Post('stories')
  @RequiresConsent(CONSENT_REQUIRED.createDraft)
  create() {
    return { ok: 'created' };
  }
}

/** The person is whoever the test's bearer token belongs to; SurrealDB verifies the token. */
class BearerForTests implements PersonAuthenticator {
  async authenticate(request: Request): Promise<AuthenticatedPerson> {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException();
    return { clerkUserId: 'from-token', token };
  }
}

describe('the consent guard on SurrealDB (D21, Art 9)', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  const create = (person: string) =>
    fetch(`${url}/v1/stories`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token(person)}` },
    });

  beforeAll(async () => {
    t = await TestDatabase.create();
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cat: 'user_cat',
    });
    await publishDpa(t, 'v1');
    const connection: Surreal = await t.service('api_user');
    const ledger = new ConsentLedger();
    const grant = (person: string, types: readonly string[]) =>
      withPersonSession(connection, t.token(person), async (s) => {
        for (const type of types)
          await ledger.grant(s, {
            form: STATEMENT_FORM[type as ConsentType],
            formVersion: 'v1',
            statement: type as never,
            mechanism: 'web_form_submission',
            privacyPolicyVersion: 'v1',
          });
      });
    // Ann: everything a draft needs (the sign-up form too, D93). Bob: none of it. Cat: all but
    // the Art 9 consent.
    await grant('user_ann', [
      ...CONSENT_REQUIRED.createDraft.types,
      'account_data',
      'age_18plus',
    ]);
    await grant(
      'user_cat',
      CONSENT_REQUIRED.submitStory.types.filter(
        (type) => type !== 'special_category_religious',
      ),
    );

    @Global()
    @Module({
      providers: [{ provide: SURREAL, useValue: connection }],
      exports: [SURREAL],
    })
    class ApiUserDatabase {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ApiUserDatabase,
        ConsentModule.forRoot({ authenticator: BearerForTests }),
      ],
      controllers: [DraftController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('lets a person with the Art 9 consent through', async () => {
    expect((await create('user_ann')).status).toBe(201);
  });

  it('refuses a person without any consent', async () => {
    const res = await create('user_bob');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'consent_required',
      consentTypes: CONSENT_REQUIRED.createDraft.types,
      subject: 'caller',
    });
  });

  it('refuses a person who gave other consents but not Art 9', async () => {
    expect((await create('user_cat')).status).toBe(403);
  });
});
