/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import DonatePage, { generateMetadata } from './page';

describe('/donate (placeholder until M4)', () => {
  it('says giving isn’t open yet, takes no payment and links back to the stories', async () => {
    const html = renderToStaticMarkup(<DonatePage />);
    expect(html).toContain('Giving isn’t open yet</h1>');
    expect(html).not.toMatch(/<form|<input|stripe/i);
    expect(html).toMatch(/href="\/stories"/);
    expect((await generateMetadata()).title).toBe('Support this work');
  });
});
