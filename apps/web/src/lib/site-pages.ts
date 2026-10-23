// The site's own pages, for the sitemap (stories are added from api-public-read). Placeholder
// pages (e.g. /donate until M4) stay out until they have real content.

export interface StaticPage {
  path: string;
  changeFrequency: 'weekly' | 'monthly' | 'yearly';
}

export const STATIC_PAGES: readonly StaticPage[] = [
  { path: '/', changeFrequency: 'weekly' },
  { path: '/stories', changeFrequency: 'weekly' },
  { path: '/about', changeFrequency: 'monthly' },
  { path: '/greatest-story', changeFrequency: 'yearly' },
  { path: '/get-ready', changeFrequency: 'monthly' },
  { path: '/next-steps', changeFrequency: 'monthly' },
  { path: '/faqs', changeFrequency: 'monthly' },
  { path: '/contact', changeFrequency: 'yearly' },
  { path: '/privacy', changeFrequency: 'yearly' },
  { path: '/terms', changeFrequency: 'yearly' },
];
