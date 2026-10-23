import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { connection } from 'next/server';
import backdrop from '@/assets/hero-backdrop.webp';
import { Logo } from '@/components/logo';
import { SHARE_HREF } from '@/components/nav/site-nav';
import { StoryCard } from '@/components/stories/story-card';
import { browseStories, listTags, type StoryTag } from '@/lib/browse';
import { featuredStorySlug } from '@/lib/config';
import { getPublicStory, StoriesUnavailableError } from '@/lib/public-stories';
import { pageMetadata } from '@/lib/seo';
import { type CardStory, summaryFromStory } from '@/lib/story-summary';

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

const FEATURED_COUNT = 3;

// The content spec's placeholder figures (home.md: "replace with real live figures before
// launch"). Shown marked as placeholders until then.
const IMPACT = [
  ['250+', 'Stories shared'],
  ['18', 'Countries reached'],
  ['25', 'Life themes covered'],
  ['12k+', 'People touched'],
] as const;

const unavailable =
  <T,>(fallback: T) =>
  (err: unknown) => {
    if (err instanceof StoriesUnavailableError) return fallback;
    throw err;
  };

/** FEATURED_STORY_SLUG's story first (until M5's featured list), then the newest. */
async function featuredStories(): Promise<CardStory[] | null> {
  const slug = featuredStorySlug();
  const [first, newest] = await Promise.all([
    slug
      ? getPublicStory(slug)
          .then((r) => (r.kind === 'story' ? summaryFromStory(r.story) : null))
          .catch(unavailable(null))
      : null,
    browseStories({ limit: FEATURED_COUNT + 1 })
      .then((p) => p.data as CardStory[])
      .catch(unavailable(null)),
  ]);
  if (!first && !newest) return null;
  const rest = (newest ?? []).filter((s) => s.slug !== first?.slug);
  return [...(first ? [first] : []), ...rest].slice(0, FEATURED_COUNT);
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
 * Home (plan 1.1), server-rendered from api-public-read (D32): the question, featured stories,
 * ways in by theme, the invitation to share, and the giving placeholder (donations are M4).
 */
export default async function Page() {
  await connection();
  const [stories, tags] = await Promise.all([
    featuredStories(),
    listTags().catch(unavailable([] as StoryTag[])),
  ]);
  const themes = tags.filter((t) => t.category === 'theme');
  const journeys = tags.filter((t) => t.category === 'journey');

  return (
    <main id="main" className="flex-1">
      {/* Always dark, in both themes: the photograph is the page's one bold moment. */}
      <section className="relative isolate flex min-h-[min(88svh,52rem)] items-center justify-center overflow-hidden bg-[#111113] px-4 pt-20 pb-32 text-center text-white">
        <Image
          src={backdrop}
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-20 object-cover opacity-70"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_30%,rgb(78_155_160/0.08),transparent_60%),linear-gradient(180deg,rgb(17_17_19/0.15)_0%,rgb(17_17_19/0.6)_100%)]"
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
        aria-labelledby="featured"
        className="mx-auto max-w-site px-4 py-16 sm:px-10 sm:py-24"
      >
        <Eyebrow id="featured">Featured stories</Eyebrow>
        {stories === null ? (
          <p
            role="status"
            className="mx-auto max-w-prose rounded-xl bg-raised px-4 py-6 text-center text-secondary-text"
          >
            Stories can’t be loaded right now. Please try again in a moment.
          </p>
        ) : (
          <ul className="mx-auto grid max-w-[30rem] gap-7 md:max-w-none md:grid-cols-3">
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

      <section
        aria-labelledby="impact"
        className="border-y border-border bg-raised"
      >
        <div className="mx-auto max-w-site px-4 py-14 sm:px-10">
          <h2 id="impact" className="sr-only">
            Impact
          </h2>
          <dl className="grid grid-cols-2 gap-8 lg:grid-cols-4">
            {IMPACT.map(([value, label]) => (
              <div key={label} className="flex flex-col text-center">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="order-first mb-2 text-[clamp(2.25rem,5vw,3.25rem)] leading-none font-bold text-link">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Placeholder figures until launch.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="support"
        className="bg-[radial-gradient(ellipse_at_50%_0%,rgb(78_155_160/0.15),transparent_70%)] px-4 py-16 text-center sm:py-24"
      >
        <div className="mx-auto max-w-xl">
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
