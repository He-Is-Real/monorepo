/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import DonatePage, { metadata } from './page';

describe('/donate (placeholder until M4)', () => {
  it('says giving isn’t open yet, takes no payment and links back to the stories', () => {
    const html = renderToStaticMarkup(<DonatePage />);
    expect(html).toContain('Giving isn’t open yet</h1>');
    expect(html).not.toMatch(/<form|<input|stripe/i);
    expect(html).toMatch(/href="\/stories"/);
    expect(metadata.alternates?.canonical).toBe('/donate');
  });
});
