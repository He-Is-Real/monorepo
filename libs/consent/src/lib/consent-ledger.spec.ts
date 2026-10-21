import {
  dpaInForce,
  evidenceHash,
  type PublishedDpa,
  reconsentRequired,
  recordKey,
} from './consent-ledger';

const dpa = (
  id: string,
  effectiveFrom: string,
  materiality: 'minor' | 'material' = 'material',
  kind = 'standard',
): PublishedDpa => ({
  id,
  kind,
  materiality,
  contentHash: 'a'.repeat(64),
  effectiveFrom,
  createdAt: effectiveFrom,
});

const NOW = Date.parse('2027-06-01T00:00:00Z');

describe('dpaInForce', () => {
  it('is undefined while nothing is published (D20: v1 is a draft)', () => {
    expect(dpaInForce([], NOW)).toBeUndefined();
  });

  it('is the newest published standard version already in effect', () => {
    const published = [
      dpa('v1', '2027-01-01T00:00:00Z'),
      dpa('v2', '2027-03-01T00:00:00Z', 'minor'),
      dpa('v3', '2027-09-01T00:00:00Z'), // not yet in effect
      dpa('legacy', '2027-05-01T00:00:00Z', 'material', 'legacy'),
    ];
    expect(dpaInForce(published, NOW)?.id).toBe('v2');
  });
});

describe('reconsentRequired (gdpr-consent.md rule 5)', () => {
  const v1 = dpa('v1', '2027-01-01T00:00:00Z');

  it('is false for consent to the version in force', () => {
    expect(reconsentRequired('v1', [v1], NOW)).toBe(false);
  });

  it('is false after a minor change (notify only)', () => {
    expect(
      reconsentRequired(
        'v1',
        [v1, dpa('v2', '2027-02-01T00:00:00Z', 'minor')],
        NOW,
      ),
    ).toBe(false);
  });

  it('is true after a material change, even if a minor one followed it', () => {
    const published = [
      v1,
      dpa('v2', '2027-02-01T00:00:00Z', 'material'),
      dpa('v3', '2027-03-01T00:00:00Z', 'minor'),
    ];
    expect(reconsentRequired('v1', published, NOW)).toBe(true);
    expect(reconsentRequired('v2', published, NOW)).toBe(false);
  });

  it('ignores a material version that isn’t in effect yet', () => {
    expect(
      reconsentRequired('v1', [v1, dpa('v2', '2027-09-01T00:00:00Z')], NOW),
    ).toBe(false);
  });
});

describe('evidenceHash (D19: instead of an IP address)', () => {
  const base = {
    dpaVersion: 'v1',
    dpaContentHash: 'b'.repeat(64),
    type: 'publish',
    event: 'granted' as const,
    mechanism: 'web_form_submission',
  };

  it('is a stable sha256 of what was presented and chosen', () => {
    expect(evidenceHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceHash({ ...base })).toBe(evidenceHash(base));
  });

  it('changes with every input', () => {
    const variants = [
      { dpaVersion: 'v2' },
      { dpaContentHash: 'c'.repeat(64) },
      { type: 'share_socials' },
      { event: 'withdrawn' as const },
      { mechanism: 'account_settings' },
    ];
    for (const v of variants) {
      expect(evidenceHash({ ...base, ...v })).not.toBe(evidenceHash(base));
    }
  });
});

describe('recordKey', () => {
  it('drops the table prefix (opaque ids, D30)', () => {
    expect(recordKey('consent:abc123')).toBe('abc123');
    expect(recordKey('dpaVersion:v1')).toBe('v1');
    expect(recordKey('dpaVersion:⟨legacy-squarespace⟩')).toBe(
      'legacy-squarespace',
    );
  });
});
