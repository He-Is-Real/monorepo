import type { Metadata } from 'next';
import { TryAgainLaterNotice } from '@/components/errors/try-again-later';
import Image from 'next/image';
import Link from 'next/link';
import { cacheLife } from 'next/cache';
import { IMPACT_FIGURES, ImpactStrip } from '@/components/home/impact-strip';
import { Logo } from '@/components/logo';
import { SHARE_HREF } from '@/components/nav/site-nav';
import { StoryCard } from '@/components/stories/story-card';
import {
  browseStories,
  listThemes,
  type StorySummary,
  type ThemeCategory,
} from '@/lib/browse';
import { logStoriesUnavailable, whenUnavailable } from '@/lib/log';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { RestartingMessage } from '@/components/restarting/restarting-message';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
import { pageMetadata } from '@/lib/seo';
import { Button, Heading, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: {
      absolute:
        'He Is Real Today: Is God real? Does God exist? Real stories from real people.',
    },
    description:
      'Is God real? Does God exist? Encouraging stories from everyday people about how God has helped them through difficult times.',
    path: '/',
  });
}

/** How many of the newest stories home shows. */
const NEWEST_COUNT = 3;

/**
 * The newest published stories. Never a chosen or pinned one (Joel, 2026-10-23: featuring one
 * person's story above the others is unfair to everyone else).
 */
/**
 * The newest stories, or why they can't be shown (logged). For a saved copy (`keep`) a failure
 * throws instead, so that render isn't kept.
 */
async function newestStories(
  keep: boolean,
): Promise<StorySummary[] | StoriesUnavailableError> {
  const newest = browseStories({ limit: NEWEST_COUNT }).then((p) => p.data);
  if (keep) return newest;
  return newest.catch((err: unknown) => {
    if (!(err instanceof StoriesUnavailableError)) throw err;
    logStoriesUnavailable('home', err);
    return err;
  });
}

/** The mockups' section label, as the section's heading. */
function Eyebrow({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Heading level={2} size="eyebrow" id={id} className="mb-4">
      {children}
    </Heading>
  );
}

/** A category's highlighted themes, each leading to browse by it. */
function ThemeTrack({ category }: { category: ThemeCategory }) {
  return (
    <div>
      <Heading level={3} size="small" className="mb-4">
        {category.name}
      </Heading>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {category.themes.map((t) => (
          <li key={t.id}>
            <Text asChild size="inherit" tone="normal" weight="bold">
              <Link
                href={`/stories?theme=${t.id}`}
                className="group flex min-h-14 items-center justify-between rounded-lg border border-border bg-card px-4 transition-colors hover:border-brand hover:bg-accent"
              >
                {t.name}
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="size-4 fill-none stroke-faint transition-transform group-hover:translate-x-0.5 group-hover:stroke-brand motion-reduce:transition-none"
                  strokeWidth="2"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </Link>
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Home (plan 1.1), server-rendered from api-public-read (D32): the question, the newest stories,
 * ways in by theme, the invitation to share, and giving (/donate, M4: Stripe's Buy Buttons; Give
 * monthly opens its Monthly option).
 */
export default function Page() {
  return cachedPage('/', savedPage, () => <Home keep={false} />);
}

/** Home's saved copy (page-cache.config.ts): never one missing its stories or themes. */
async function savedPage(life: PageCacheLife) {
  'use cache';
  cacheLife(life);
  // Called, not rendered, so a failed read rejects here and nothing is kept.
  return Home({ keep: true });
}

async function Home({ keep }: { keep: boolean }) {
  const [stories, categories] = await Promise.all([
    newestStories(keep),
    keep
      ? listThemes()
      : listThemes().catch(whenUnavailable('home', [] as ThemeCategory[])),
  ]);
  // One row per category that has highlighted themes (themes plan v3, Q3 B).
  const tracks = categories
    .map((c) => ({ ...c, themes: c.themes.filter((t) => t.highlighted) }))
    .filter((c) => c.themes.length > 0);

  return (
    <main id="main" className="flex-1">
      {/*
        Always dark, in both themes: the page's one bold moment. The design's backdrop photo:
        Keagan Henman's "black metal framed padded folding chair" (Unsplash, iFBIdX54BOk; free
        under the Unsplash License), greyscale and darkened to 72% in the file itself.
      */}
      <section className="relative isolate flex min-h-[min(88svh,52rem)] items-center justify-center overflow-hidden bg-hero px-4 pt-20 pb-32 text-center">
        <Image
          src="/hero-backdrop.webp"
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-10 object-cover"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_30%,color-mix(in_srgb,var(--brand)_6%,transparent)_0%,transparent_60%),linear-gradient(180deg,color-mix(in_srgb,var(--hero)_5%,transparent)_0%,color-mix(in_srgb,var(--hero)_28%,transparent)_60%,color-mix(in_srgb,var(--hero)_60%,transparent)_100%)]"
        />
        {/* The fade into the page stays below the content (pb-32), so text keeps its contrast. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 -z-10 h-24 bg-linear-to-b from-transparent to-background"
        />
        <Text as="div" size="inherit" tone="media" className="max-w-2xl">
          <Logo
            size={120}
            className="mx-auto mb-10 animate-in fade-in duration-700 [--logo:var(--on-media)]"
          />
          <Heading
            level={1}
            size="display"
            className="animate-in fade-in slide-in-from-bottom-4 delay-150 duration-700 fill-mode-both"
          >
            {/* eslint-disable @heisreal/web-ui/no-text-look -- the hero's teal "God", the page's one bold moment on the always-dark hero (styling order, step 4) */}
            Is <em className="text-brand-bright">God</em> Real?
            <br />
            Does <em className="text-brand-bright">God</em> exist?
            {/* eslint-enable @heisreal/web-ui/no-text-look */}
          </Heading>
          <Text
            size="intro"
            tone="media-quiet"
            className="mx-auto mt-7 max-w-xl animate-in fade-in slide-in-from-bottom-4 delay-300 duration-700 fill-mode-both"
          >
            Whatever brought you here, you’ll find real stories from real people
            about moments that changed them. No scripts, no performance, just
            honesty.
          </Text>
          <div className="mt-10 flex flex-wrap justify-center gap-4 animate-in fade-in delay-500 duration-700 fill-mode-both">
            {/* The library's large buttons (BT-1 A), in the hero's own colours: it is dark in
                both themes. */}
            {/* eslint-disable @heisreal/web-ui/no-text-look -- the hero's own button colours, dark in both themes (styling order, step 4) */}
            <Button
              asChild
              size="lg"
              wrap
              className="bg-brand text-hero hover:bg-brand-bright hover:text-hero"
            >
              <Link href="/stories">Browse stories</Link>
            </Button>
            <Button
              asChild
              size="lg"
              wrap
              variant="outline"
              className="border-on-media/30 bg-transparent text-on-media hover:border-brand-bright hover:bg-on-media/5 hover:text-on-media dark:bg-transparent"
            >
              <Link href={SHARE_HREF}>Share your story</Link>
            </Button>
            {/* eslint-enable @heisreal/web-ui/no-text-look */}
          </div>
        </Text>
      </section>

      <section
        aria-labelledby="newest"
        className="mx-auto max-w-site px-4 py-16 sm:px-10 sm:py-24"
      >
        <Eyebrow id="newest">Recently shared</Eyebrow>
        {stories instanceof StoriesUnavailableError &&
        stories.restartingSeconds !== undefined ? (
          <RestartingMessage
            seconds={stories.restartingSeconds}
            variant="inline"
          />
        ) : stories instanceof StoriesUnavailableError ? (
          <TryAgainLaterNotice
            role="status"
            className="mx-auto max-w-measure"
          />
        ) : (
          <ul className="mx-auto grid max-w-[30rem] grid-cols-[minmax(0,1fr)] gap-7 md:max-w-none md:grid-cols-3">
            {stories.map((s) => (
              <li key={s.id}>
                <StoryCard story={s} uniform eager />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-10 text-center">
          <TextLink href="/stories" kind="standalone">
            View all stories
          </TextLink>
        </p>
      </section>

      {tracks.length > 0 && (
        <section
          aria-labelledby="explore"
          className="border-y border-border bg-raised"
        >
          <div className="mx-auto max-w-site px-4 py-16 sm:px-10 sm:py-24">
            <div className="mb-10 text-center">
              <Eyebrow id="explore">Explore stories</Eyebrow>
              <Text size="intro" tone="quiet">
                Find stories from people who’ve been where you are.
              </Text>
            </div>
            <div className="grid gap-10 lg:grid-cols-2 lg:gap-14">
              {tracks.map((c) => (
                <ThemeTrack key={c.id} category={c} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section
        aria-labelledby="your-story"
        className="relative mx-auto max-w-site px-4 py-16 text-center sm:px-10 sm:py-24"
      >
        <span
          aria-hidden="true"
          className="absolute top-0 left-1/2 h-px w-20 -translate-x-1/2 bg-linear-to-r from-transparent via-brand to-transparent"
        />
        <Eyebrow id="your-story">Your story</Eyebrow>
        <Text size="intro" tone="quiet" className="mx-auto max-w-xl">
          Whether it’s a moment of healing, an answered prayer, a life turned
          around, or simply His faithfulness, someone out there needs to hear
          how you discovered God is real.
        </Text>
        <p className="mt-8">
          <Button asChild size="lg" wrap>
            <Link href={SHARE_HREF}>Get ready to share</Link>
          </Button>
        </p>
      </section>

      <ImpactStrip figures={IMPACT_FIGURES} />

      <section
        aria-labelledby="support"
        className="bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_srgb,var(--brand)_15%,transparent),transparent_70%)] px-4 py-16 text-center sm:py-24"
      >
        <div className="mx-auto max-w-measure">
          <Heading level={2} id="support" className="mb-3">
            Support this work
          </Heading>
          <Text size="intro" tone="quiet">
            He Is Real Today is a not-for-profit. We rely on the generosity of
            people who believe these stories matter.
          </Text>
          <Text size="small" tone="quiet" className="mt-2">
            Every donation goes to publishing more stories and reaching more
            people. UK taxpayers can add 25% through Gift Aid at no extra cost.
          </Text>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" wrap variant="outline">
              <Link href="/donate">Give once</Link>
            </Button>
            <Button asChild size="lg" wrap>
              <Link href="/donate?frequency=monthly">Give monthly</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
