import { BadRequestException } from '@nestjs/common';
import {
  parseGrantConsent,
  parseIdempotencyKey,
  weakETag,
} from './account-consents.controller';

describe('parseGrantConsent', () => {
  it('accepts the contract’s GrantConsent', () => {
    expect(
      parseGrantConsent({
        type: 'special_category_religious',
        dpaVersion: 'v1',
        mechanism: 'web_form_submission',
        ignored: true,
      }),
    ).toEqual({
      type: 'special_category_religious',
      dpaVersion: 'v1',
      mechanism: 'web_form_submission',
    });
  });

  it('refuses unknown types and mechanisms, including the migrator-only ones', () => {
    for (const body of [
      {
        type: 'legacy-migration',
        dpaVersion: 'v1',
        mechanism: 'web_form_submission',
      },
      { type: 'publish', dpaVersion: 'v1', mechanism: 'legacy_import' },
      {
        type: 'publish',
        dpaVersion: 'dpaVersion:v1; DELETE consent',
        mechanism: 'web_form_submission',
      },
      {},
      null,
    ]) {
      expect(() => parseGrantConsent(body)).toThrow(BadRequestException);
    }
  });
});

describe('parseIdempotencyKey (D29)', () => {
  it('requires 16–128 characters', () => {
    expect(() => parseIdempotencyKey(undefined)).toThrow(BadRequestException);
    expect(() => parseIdempotencyKey('short')).toThrow(BadRequestException);
    expect(() => parseIdempotencyKey('x'.repeat(129))).toThrow(
      BadRequestException,
    );
    const key = '6f1c2d4e-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
    expect(parseIdempotencyKey(key)).toBe(key);
  });
});

describe('weakETag', () => {
  it('is weak and follows the representation', () => {
    expect(weakETag({ a: 1 })).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(weakETag({ a: 1 })).toBe(weakETag({ a: 1 }));
    expect(weakETag({ a: 2 })).not.toBe(weakETag({ a: 1 }));
  });
});
