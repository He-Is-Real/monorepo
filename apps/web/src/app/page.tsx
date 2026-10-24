import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { connection } from 'next/server';
import { IMPACT_FIGURES, ImpactStrip } from '@/components/home/impact-strip';
import { Logo } from '@/components/logo';
import { SHARE_HREF } from '@/components/nav/site-nav';
import { StoryCard } from '@/components/stories/story-card';
import {
  browseStories,
  listTags,
  type StorySummary,
  type StoryTag,
} from '@/lib/browse';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { pageMetadata } from '@/lib/seo';

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

const unavailable =
  <T,>(fallback: T) =>
  (err: unknown) => {
    if (err instanceof StoriesUnavailableError) return fallback;
    throw err;
  };

/**
 * The newest published stories. Never a chosen or pinned one (Joel, 2026-10-23: featuring one
 * person's story above the others is unfair to everyone else).
 */
async function newestStories(): Promise<StorySummary[] | null> {
  return browseStories({ limit: NEWEST_COUNT })
    .then((p) => p.data)
    .catch(unavailable(null));
}

/** The mockups' section label, as the section's heading. */
function Eyebrow({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mb-4 text-sm font-semibold tracking-[0.2em] text-link uppercase"
    >
      {children}
    </h2>
  );
}

function TagTrack({ label, tags }: { label: string; tags: StoryTag[] }) {
  if (tags.length === 0) return null;
  return (
    <div>
      <h3 className="mb-4 text-lg text-secondary-text italic">{label}</h3>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {tags.map((t) => (
          <li key={t.slug}>
            <Link
              href={`/stories?tag=${t.slug}`}
              className="group flex min-h-14 items-center justify-between rounded-lg border border-border bg-card px-4 font-semibold text-foreground transition-colors hover:border-teal hover:bg-accent hover:text-foreground"
            >
              {t.name}
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-4 fill-none stroke-faint transition-transform group-hover:translate-x-0.5 group-hover:stroke-teal motion-reduce:transition-none"
                strokeWidth="2"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const button =
  'inline-flex min-h-12 items-center justify-center rounded-lg px-7 font-semibold transition-colors';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground`;

/**
 * Home (plan 1.1), server-rendered from api-public-read (D32): the question, the newest stories,
 * ways in by theme, the invitation to share, and the giving placeholder (donations are M4).
 */
export default async function Page() {
  await connection();
  const [stories, tags] = await Promise.all([
    newestStories(),
    listTags().catch(unavailable([] as StoryTag[])),
  ]);
  const themes = tags.filter((t) => t.category === 'theme');
  const journeys = tags.filter((t) => t.category === 'journey');

  return (
    <main id="main" className="flex-1">
      {/*
        Always dark, in both themes: the page's one bold moment. The design's backdrop photo:
        Keagan Henman's "black metal framed padded folding chair" (Unsplash, iFBIdX54BOk; free
        under the Unsplash License), greyscale and darkened to 72% in the file itself.
      */}
      <section className="relative isolate flex min-h-[min(88svh,52rem)] items-center justify-center overflow-hidden bg-[#111113] px-4 pt-20 pb-32 text-center text-white">
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
          className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_30%,rgb(78_155_160/0.06)_0%,transparent_60%),linear-gradient(180deg,rgb(17_17_19/0.05)_0%,rgb(17_17_19/0.28)_60%,rgb(17_17_19/0.6)_100%)]"
        />
        {/* The fade into the page stays below the content (pb-32), so text keeps its contrast. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 -z-10 h-24 bg-linear-to-b from-transparent to-background"
        />
        <div className="max-w-2xl">
          <Logo
            size={120}
            className="mx-auto mb-10 animate-in fade-in duration-700 [--logo:#fff]"
          />
          <h1 className="text-[clamp(2.5rem,7vw,4rem)] leading-[1.12] font-normal tracking-tight animate-in fade-in slide-in-from-bottom-4 delay-150 duration-700 fill-mode-both">
            Is <em className="text-teal-light">God</em> Real?
            <br />
            Does <em className="text-teal-light">God</em> exist?
          </h1>
          <p className="mx-auto mt-7 max-w-xl text-[clamp(1rem,2vw,1.2rem)] leading-relaxed text-white/80 animate-in fade-in slide-in-from-bottom-4 delay-300 duration-700 fill-mode-both">
            Whatever brought you here, you’ll find real stories from real people
            about moments that changed them. No scripts, no performance, just
            honesty.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-4 animate-in fade-in delay-500 duration-700 fill-mode-both">
            <Link
              href="/stories"
              className={`${button} bg-teal text-[#111113] hover:bg-teal-light hover:text-[#111113]`}
            >
              Browse stories
            </Link>
            <Link
              href={SHARE_HREF}
              className={`${button} border border-white/30 text-white hover:border-teal-light hover:bg-white/5 hover:text-white`}
            >
              Share your story
            </Link>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="newest"
        className="mx-auto max-w-site px-4 py-16 sm:px-10 sm:py-24"
      >
        <Eyebrow id="newest">Recently shared</Eyebrow>
        {stories === null ? (
          <p
            role="status"
            className="mx-auto max-w-measure rounded-xl bg-raised px-4 py-6 text-center text-secondary-text"
          >
            Stories can’t be loaded right now. Please try again in a moment.
          </p>
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
          <Link
            href="/stories"
            className="inline-flex min-h-11 items-center font-medium"
          >
            View all stories
          </Link>
        </p>
      </section>

      {(themes.length > 0 || journeys.length > 0) && (
        <section
          aria-labelledby="explore"
          className="border-y border-border bg-raised"
        >
          <div className="mx-auto max-w-site px-4 py-16 sm:px-10 sm:py-24">
            <div className="mb-10 text-center">
              <Eyebrow id="explore">Explore stories</Eyebrow>
              <p className="text-lg text-secondary-text">
                Find stories from people who’ve been where you are.
              </p>
            </div>
            <div className="grid gap-10 lg:grid-cols-[3fr_2fr] lg:gap-14">
              <TagTrack label="Going through something?" tags={themes} />
              <TagTrack label="Curious about faith?" tags={journeys} />
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
          className="absolute top-0 left-1/2 h-px w-20 -translate-x-1/2 bg-linear-to-r from-transparent via-teal to-transparent"
        />
        <Eyebrow id="your-story">Your story</Eyebrow>
        <p className="mx-auto max-w-xl text-lg text-secondary-text">
          Whether it’s a moment of healing, an answered prayer, a life turned
          around, or simply His faithfulness, someone out there needs to hear
          how you discovered God is real.
        </p>
        <p className="mt-8">
          <Link href={SHARE_HREF} className={primary}>
            Get ready to share
          </Link>
        </p>
      </section>

      <ImpactStrip figures={IMPACT_FIGURES} />

      <section
        aria-labelledby="support"
        className="bg-[radial-gradient(ellipse_at_50%_0%,rgb(78_155_160/0.15),transparent_70%)] px-4 py-16 text-center sm:py-24"
      >
        <div className="mx-auto max-w-measure">
          <h2
            id="support"
            className="mb-3 text-[clamp(1.75rem,3.5vw,2.5rem)] font-normal"
          >
            Support this work
          </h2>
          <p className="text-lg text-secondary-text">
            He Is Real Today is a not-for-profit. We rely on the generosity of
            people who believe these stories matter.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Every donation goes to publishing more stories and reaching more
            people. UK taxpayers can add 25% through Gift Aid at no extra cost.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link
              href="/donate"
              className={`${button} border-[1.5px] border-link text-link hover:bg-primary hover:text-primary-foreground`}
            >
              Give once
            </Link>
            <Link href="/donate" className={primary}>
              Give monthly
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
