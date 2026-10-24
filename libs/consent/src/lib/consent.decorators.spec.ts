import { Controller, Get } from '@nestjs/common';
import {
  NoConsentRequired,
  RequiresConsent,
  resolveConsentPolicy,
} from './consent.decorators';
import { CONSENT_REQUIRED, type ConsentType } from './consent.types';

@Controller('a')
class Undecorated {
  @Get() plain() {
    return 1;
  }
  @Get('x') @NoConsentRequired('public reference data') open() {
    return 1;
  }
  @Get('y') @RequiresConsent(CONSENT_REQUIRED.createDraft) guarded() {
    return 1;
  }
}

@NoConsentRequired('every route here is a probe')
@Controller('b')
class ClassLevel {
  @Get() inherited() {
    return 1;
  }
  @Get('x') @RequiresConsent(CONSENT_REQUIRED.submitStory) both() {
    return 1;
  }
}

const proto = <T>(c: { prototype: T }) => c.prototype as Record<string, object>;

describe('resolveConsentPolicy', () => {
  it('refuses a route with neither decorator', () => {
    expect(
      resolveConsentPolicy(proto(Undecorated)['plain'], Undecorated),
    ).toEqual({
      ok: false,
      problem: 'has neither @RequiresConsent nor @NoConsentRequired',
    });
  });

  it('refuses two decorators (class and handler): exactly one per route', () => {
    expect(resolveConsentPolicy(proto(ClassLevel)['both'], ClassLevel)).toEqual(
      {
        ok: false,
        problem: 'has more than one consent decorator (handler and controller)',
      },
    );
  });
});

describe('decorator arguments', () => {
  it('@RequiresConsent needs at least one known type', () => {
    expect(() => RequiresConsent({ subject: 'caller', types: [] })).toThrow(
      'at least one consent type',
    );
    expect(() =>
      RequiresConsent({
        subject: 'caller',
        types: ['legacy-migration' as ConsentType],
      }),
    ).toThrow('unknown consent type legacy-migration');
  });

  it('@NoConsentRequired needs a real reason', () => {
    expect(() => NoConsentRequired('  ')).toThrow('needs a real reason');
  });
});

describe('CONSENT_REQUIRED (docs/api-conventions.md, "Consent on routes")', () => {
  it('creating, editing and uploading to a draft need the caller’s current Art 9 consent', () => {
    for (const r of [
      CONSENT_REQUIRED.createDraft,
      CONSENT_REQUIRED.editDraft,
      CONSENT_REQUIRED.requestUpload,
    ]) {
      expect(r).toEqual({
        subject: 'caller',
        types: ['special_category_religious'],
      });
    }
  });

  it('submit needs Art 9, publish and age; approve needs the same of the submitter', () => {
    const three = ['special_category_religious', 'publish', 'age_18plus'];
    expect(CONSENT_REQUIRED.submitStory).toEqual({
      subject: 'caller',
      types: three,
    });
    expect(CONSENT_REQUIRED.approveStory).toEqual({
      subject: 'submitter',
      types: three,
      storyParam: 'id',
    });
  });
});
