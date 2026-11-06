import { DATASET } from './index';

// D47's dummy dataset goes onto dev: everything in it must read as test content.
describe('the D47 dummy dataset', () => {
  it('is obviously test content', () => {
    for (const s of DATASET.stories) {
      const text = `${s.title} ${s.description} ${s.body ?? ''} ${s.bylineName ?? ''}`;
      expect(text).toMatch(/test|dummy|Test|Dummy|Δοκιμαστική/);
    }
  });
});
