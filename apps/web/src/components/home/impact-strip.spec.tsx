/**
 * @jest-environment node
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IMPACT_FIGURES, ImpactStrip } from './impact-strip';

describe('ImpactStrip (home)', () => {
  it('renders nothing without figures: none are real yet', () => {
    expect(IMPACT_FIGURES).toEqual([]);
    expect(renderToStaticMarkup(<ImpactStrip figures={IMPACT_FIGURES} />)).toBe(
      '',
    );
  });

  it('shows real figures as a description list once they exist', () => {
    const html = renderToStaticMarkup(
      <ImpactStrip figures={[{ value: '30', label: 'Stories shared' }]} />,
    );
    expect(html).toContain('aria-labelledby="impact"');
    expect(html).toMatch(/<dt[^>]*>Stories shared<\/dt><dd[^>]*>30<\/dd>/);
  });
});
