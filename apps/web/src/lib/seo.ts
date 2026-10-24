import type { Metadata } from 'next';
import { siteUrl } from './config';

// Search and social metadata (M1 1.7). Every URL is absolute, built from SITE_URL (config.ts);
// without it, no URL-bearing metadata is emitted. Whether search engines may index the site
// at all is a separate, explicit switch: INDEXING=allow (config.ts, robots.ts).

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

// Open Graph fields that carry a URL: without a site URL there's nothing absolute to give, and
// Next would otherwise fill in http://localhost:<port> or leave them relative.
const URL_FIELDS = ['url', 'images', 'videos', 'audio'] as const;

const absolute = (origin: string, images: Image[]) =>
  images.map((i) => ({ ...i, url: new URL(i.url, `${origin}/`).href }));

/**
 * The site's social defaults for the root layout: with a site URL, the brand card by absolute
 * URL; without one, no image at all (a plain `summary` card).
 */
export function socialDefaults(
  origin = siteUrl(),
): Pick<Metadata, 'openGraph' | 'twitter'> {
  if (!origin) {
    return {
      openGraph: { ...OPEN_GRAPH_DEFAULTS },
      twitter: { card: 'summary' },
    };
  }
  const images = absolute(origin, [DEFAULT_OG_IMAGE]);
  return {
    openGraph: { ...OPEN_GRAPH_DEFAULTS, images },
    twitter: { card: 'summary_large_image', images },
  };
}

/**
 * A page's metadata: title, description, its own canonical URL, and Open Graph and Twitter
 * cards that keep the site's defaults. Next replaces the layout's whole `openGraph` object
 * when a page sets one, so every page goes through here. URLs are absolute, from SITE_URL;
 * without it, every URL-bearing field (canonical, og:url, images) is left out. Reads the
 * environment, so call it per request, in `generateMetadata`. The root layout sets no
 * canonical: its children would inherit it.
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
  /** Paths (or absolute URLs) of the page's images, made absolute against SITE_URL. */
  images?: Image[];
  /** Extra Open Graph fields, e.g. `type: 'article'` and `publishedTime` for stories. */
  openGraph?: Partial<OpenGraph>;
}): Metadata {
  const text = typeof title === 'string' ? title : title.absolute;
  const origin = siteUrl();
  if (!origin) {
    const extra: Record<string, unknown> = { ...openGraph };
    for (const field of URL_FIELDS) delete extra[field];
    return {
      title,
      description,
      openGraph: {
        ...OPEN_GRAPH_DEFAULTS,
        title: text,
        description,
        ...extra,
      } as OpenGraph,
      twitter: { card: 'summary', title: text, description },
    };
  }
  const url = new URL(path, `${origin}/`).href;
  const absoluteImages = absolute(origin, images);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      ...OPEN_GRAPH_DEFAULTS,
      title: text,
      description,
      url,
      images: absoluteImages,
      ...openGraph,
    } as OpenGraph,
    twitter: {
      card: 'summary_large_image',
      title: text,
      description,
      images: absoluteImages,
    },
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
