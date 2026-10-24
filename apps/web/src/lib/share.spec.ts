import { shareLinks } from './share';

describe('shareLinks (plain share URLs, no SDKs)', () => {
  it('builds WhatsApp, Facebook and X links with the page URL and title encoded', () => {
    const links = shareLinks(
      'https://example.org/stories/a-b?x=1',
      'Hope & healing',
    );
    expect(links.whatsapp).toBe(
      'https://wa.me/?text=Hope%20%26%20healing%20https%3A%2F%2Fexample.org%2Fstories%2Fa-b%3Fx%3D1',
    );
    expect(links.facebook).toBe(
      'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fexample.org%2Fstories%2Fa-b%3Fx%3D1',
    );
    expect(links.x).toBe(
      'https://x.com/intent/post?url=https%3A%2F%2Fexample.org%2Fstories%2Fa-b%3Fx%3D1&text=Hope%20%26%20healing',
    );
  });
});
