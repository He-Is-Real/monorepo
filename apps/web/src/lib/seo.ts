import type { Metadata } from 'next';

// Search and social metadata (M1 1.7). Relative URLs here resolve against `metadataBase`,
// which the root layout sets from SITE_URL (config.ts). Whether search engines may index the
// site at all is a separate switch: ROBOTS_NOINDEX (decision 21) and robots.ts.

export const SITE_NAME = 'He Is Real Today';
export const SITE_DESCRIPTION =
  'Real stories from everyday people who have encountered God. Is God real? Hear their stories and decide for yourself.';

/** The brand card every page shares unless it passes its own (public/og-default.png). */
export const DEFAULT_OG_IMAGE = {
  url: '/og-default.png',
  width: 1200,
  height: 630,
  alt: 'He Is Real Today',
};

type OpenGraph = NonNullable<Metadata['openGraph']>;
type Image = { url: string; width: number; height: number; alt: string };

export const OPEN_GRAPH_DEFAULTS = {
  siteName: SITE_NAME,
  locale: 'en_GB',
  type: 'website',
} as const;

/**
 * A page's metadata: title, description, its own canonical URL, and Open Graph and Twitter
 * cards that keep the site's defaults. Next replaces the layout's whole `openGraph` object
 * when a page sets one, so every page goes through here. The root layout sets no canonical:
 * its children would inherit it.
 */
export function pageMetadata({
  title,
  description,
  path,
  images = [DEFAULT_OG_IMAGE],
  openGraph,
}: {
  title: string | { absolute: string };
  description: string;
  /** The page's path, e.g. `/about`. */
  path: string;
  images?: Image[];
  /** Extra Open Graph fields, e.g. `type: 'article'` and `publishedTime` for stories. */
  openGraph?: Partial<OpenGraph>;
}): Metadata {
  const text = typeof title === 'string' ? title : title.absolute;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      ...OPEN_GRAPH_DEFAULTS,
      title: text,
      description,
      url: path,
      images,
      ...openGraph,
    } as OpenGraph,
    twitter: { card: 'summary_large_image', title: text, description, images },
  };
}

/** schema.org Organization and WebSite (on every page, from the root layout). */
export function siteJsonLd(origin: string): object {
  const url = `${origin}/`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${url}#organization`,
        name: SITE_NAME,
        url,
        logo: `${origin}/logo.png`,
        description:
          'A UK-based not-for-profit sharing real stories of encounters with God. Not affiliated with any particular Christian denomination.',
      },
      {
        '@type': 'WebSite',
        '@id': `${url}#website`,
        name: SITE_NAME,
        url,
        inLanguage: 'en-GB',
        publisher: { '@id': `${url}#organization` },
      },
    ],
  };
}

/**
 * JSON for a `<script type="application/ld+json">`: `<` is escaped so text from the data
 * (a story's title, an FAQ answer) can never close the element.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
