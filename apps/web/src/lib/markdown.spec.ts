import { renderLegalMarkdown } from './markdown';

/**
 * The renderer's safety rules (D125): its HTML is set as the page's, so these are checked
 * where they're decided. How the documents look is the e2e suites' (legal-documents.e2e.ts).
 */
describe('renderLegalMarkdown', () => {
  const html = (md: string) => {
    const div = document.createElement('div');
    div.innerHTML = renderLegalMarkdown(md);
    return div;
  };

  it('shows raw HTML as text, never as markup', () => {
    const div = html(
      '<script>alert(1)</script>\n\nHi <img src=x onerror=alert(1)> <b>there</b>',
    );
    expect(div.querySelector('script, img, b')).toBeNull();
    expect(div.textContent).toContain('<script>alert(1)</script>');
    expect(div.textContent).toContain('<b>there</b>');
  });

  it('keeps https:, mailto: and this site’s links only', () => {
    const div = html(
      [
        '[a](https://stripe.com/gb/privacy) [b](mailto:info@heisreal.today) [c](/terms)',
        '[d](#cookies) [e](javascript:alert(1)) [f](http://example.com)',
        '[g](//evil.example) [h](data:text/html,x)',
      ].join(' '),
    );
    expect(
      [...div.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    ).toEqual([
      'https://stripe.com/gb/privacy',
      'mailto:info@heisreal.today',
      '/terms',
      '#cookies',
    ]);
    // No images: at most a link to one.
    expect(
      html('![i](https://example.com/i.png)').querySelector('img'),
    ).toBeNull();
  });

  it('renders inline and block code as real <code>', () => {
    const div = html('The file `v1.md`.\n\n```\nfenced <b>code</b>\n```');
    const codes = [...div.querySelectorAll('code')];
    expect(codes.map((c) => c.textContent)).toEqual([
      'v1.md',
      'fenced <b>code</b>\n',
    ]);
    expect(codes[0].className).toContain('font-mono');
    expect(div.querySelector('pre > code')).not.toBeNull();
  });

  it('names heading anchors, starting at the page’s level', () => {
    const div = html('## Cookies and storage {#cookies}\n\n### Then\n');
    expect(div.querySelector('h2')?.id).toBe('cookies');
    expect(div.querySelector('h2')?.textContent).toBe('Cookies and storage');
    expect(div.querySelector('h3')?.id).toBe('then');
  });

  it('labels each table cell with its column, for phones', () => {
    const div = html(
      '## Storage\n\n| Name | Set by |\n| --- | --- |\n| `theme` | This site |\n',
    );
    expect(div.querySelector('caption')?.textContent).toBe('Storage');
    expect(div.querySelector('tbody th[scope=row] code')?.textContent).toBe(
      'theme',
    );
    expect(div.querySelector('tbody td')?.getAttribute('data-label')).toBe(
      'Set by',
    );
  });
});
