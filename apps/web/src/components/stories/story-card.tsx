import Image from 'next/image';
import Link from 'next/link';
import type { StorySummary } from '@/lib/browse';
import { audioSize, cardAspect } from '@/lib/shape';
import { CardPlayer } from './card-player';
import { CardHeart } from './heart-button';

// A story's card (browse, home, related). Its parts and sizes mirror lib/masonry.ts, which
// predicts its height (D55): change them together. The card's one link is its title, stretched
// over the whole card, so the link's name is the story's title and themes stay plain text. On
// video and audio cards the media area plays the story instead (card-player.tsx), so the link
// covers only the text below it. No counts or metrics of any kind (design principles).
// The person's heart sits in the top-right corner, over the picture when there is one, so it
// never changes the card's height; it fills in from the browser (heart-button.tsx, D83).

/** Home's uniform media box (the mockup's 16:10). */
const UNIFORM_ASPECT = 16 / 10;
/** About 1,000 characters a minute (200 words of 5 letters). */
const CHARS_PER_MINUTE = 1000;

export const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export const readingMinutes = (chars: number) =>
  Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE));

// Quiet placeholders from the mockups, for a card without a signed picture: home's written stories
// without an image, or any card while signing is off. Audio cards show their thumbnail (U2).
const PLACEHOLDERS = [
  ['#1a3a3d', '#0d1f21', '#4e9ba0'],
  ['#1e2e28', '#0f1a14', '#5a7a6a'],
  ['#2a2a1e', '#1a1a10', '#8a8a4e'],
  ['#1e1e30', '#101020', '#5a5a8a'],
  ['#301e1e', '#201010', '#8a5a5a'],
] as const;

function placeholderFor(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PLACEHOLDERS[hash % PLACEHOLDERS.length];
}

export function cardLabel(story: StorySummary): string {
  if (story.primaryFormat === 'written')
    return `Written · ${readingMinutes(story.textLength)} min read`;
  const kind = story.primaryFormat === 'video' ? 'Video' : 'Audio';
  return story.durationSeconds
    ? `${kind} · ${formatDuration(story.durationSeconds)}`
    : kind;
}

/**
 * D72: "NEW" while the story is less than 7 days old (`story.isNew`, decided on web's server).
 * The mockup's teal pill on the site's tokens: the link-hover teal on a teal tint (about 6:1 in
 * both themes). It sits in the card's top line, at its 20 px height, so it never covers the
 * picture, the play button or the player, and the masonry's predicted heights stay right. Words,
 * not colour alone: screen readers hear "New: published in the last week".
 */
export function NewBadge() {
  return (
    <span
      data-new-badge=""
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-teal/15 px-1.5 text-[0.6875rem] leading-5 font-semibold tracking-wide text-link-hover dark:bg-teal/20"
    >
      <span aria-hidden="true">NEW</span>
      <span className="sr-only">New: published in the last week</span>
    </span>
  );
}

/**
 * A card's picture and its clamped shape (D53), as browse shows it; null for a written story
 * without an image (home's `uniform` gives it a 16:10 placeholder instead).
 */
export function cardMedia(story: StorySummary, uniform = false) {
  const { primaryFormat: format, image } = story;
  if (format === 'video')
    return {
      aspect: cardAspect(story.thumbnailWidth, story.thumbnailHeight),
      src: story.thumbnailUrl,
      width: story.thumbnailWidth,
      height: story.thumbnailHeight,
    };
  if (format === 'audio') {
    // Its thumbnail (the person's image or the site's default), at that picture's shape.
    const { width, height } = audioSize(
      story.thumbnailWidth,
      story.thumbnailHeight,
    );
    return {
      aspect: cardAspect(width, height),
      src: story.thumbnailUrl,
      width,
      height,
    };
  }
  if (image)
    return {
      aspect: cardAspect(image.width, image.height),
      src: image.url,
      width: image.width,
      height: image.height,
    };
  return uniform ? { aspect: UNIFORM_ASPECT, src: null } : null;
}

export function StoryCard({
  story,
  uniform = false,
  headingLevel = 3,
  eager = false,
}: {
  story: StorySummary;
  /** Home: every card's media in the same 16:10 box, cropped. */
  uniform?: boolean;
  headingLevel?: 2 | 3;
  /** The first cards on screen: load their pictures straight away. */
  eager?: boolean;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const media = cardMedia(story, uniform);
  const quote = media === null; // a written story without an image
  const [from, to, accent] = placeholderFor(story.id);
  const initial = [
    ...(story.bylineName?.trim() || story.title),
  ][0]?.toUpperCase();
  const format = story.primaryFormat;
  const playable = format !== 'written';
  const aspect = uniform ? UNIFORM_ASPECT : (media?.aspect ?? 1);

  const picture = media && (
    <>
      {media.src ? (
        <Image
          src={media.src}
          alt=""
          width={media.width ?? 640}
          height={media.height ?? 400}
          unoptimized
          loading={eager ? 'eager' : 'lazy'}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center"
          style={{ background: `linear-gradient(145deg, ${from}, ${to})` }}
        >
          <span
            className="flex size-16 items-center justify-center rounded-full text-2xl font-bold text-white shadow-lg"
            style={{ background: accent }}
          >
            {initial}
          </span>
        </div>
      )}
      {playable && (
        <span
          aria-hidden="true"
          className="absolute right-3 bottom-3 flex size-11 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur-sm transition-transform group-hover/play:scale-105 motion-reduce:transition-none"
        >
          {format === 'video' ? (
            <svg viewBox="0 0 24 24" className="ml-0.5 size-4 fill-current">
              <polygon points="8,5 19,12 8,19" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="size-5 fill-none stroke-current"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
            </svg>
          )}
        </span>
      )}
    </>
  );

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border transition-[box-shadow,background-color] [overflow-wrap:anywhere] hover:ring-border-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      {media &&
        (playable ? (
          <CardPlayer
            slug={story.slug}
            title={story.title}
            format={format}
            aspect={aspect}
          >
            {picture}
          </CardPlayer>
        ) : (
          <div
            data-card-media=""
            className="relative w-full shrink-0 overflow-hidden bg-surface"
            style={{ aspectRatio: String(aspect) }}
          >
            {picture}
          </div>
        ))}
      <div
        className={`flex flex-1 flex-col p-5 ${playable && media ? 'relative' : ''}`}
      >
        {/* One line at normal text sizes: the name shortens with "…" first. It moves to its own line
            only when under 2.5rem would be left, and with large text the label wraps too, so
            nothing is ever clipped by the card. */}
        <p
          className={`mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[0.8125rem] leading-5 text-muted-foreground ${media ? '' : 'pr-10'}`}
        >
          <span
            data-card-label=""
            className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1"
          >
            {story.isNew && <NewBadge />}
            {cardLabel(story)}
          </span>
          <span className="min-w-0 flex-1 basis-10 truncate text-right">
            {story.bylineName ?? 'Anonymous'}
          </span>
        </p>
        <Heading className="mb-1.5 line-clamp-3 text-[1.0625rem] leading-6 font-semibold">
          <Link
            href={`/stories/${story.slug}`}
            // No prefetch: a story's page reads the story, which signs its player link (D52);
            // links are signed only for stories someone opens or plays.
            prefetch={false}
            className="text-foreground outline-none after:absolute after:inset-0 after:content-[''] hover:text-foreground"
          >
            {story.title}
          </Link>
        </Heading>
        {quote ? (
          <blockquote className="line-clamp-6 border-l-2 border-teal pl-3 text-lg leading-7 text-secondary-text">
            {story.excerpt}
          </blockquote>
        ) : (
          <p className="line-clamp-3 text-[0.9375rem] leading-6 text-secondary-text italic">
            {story.excerpt}
          </p>
        )}
        {story.themes.length > 0 && (
          <ul className="mt-3.5 flex flex-wrap gap-1.5" aria-label="Themes">
            {story.themes.map((t) => (
              <li
                key={t.id}
                className="h-6 truncate rounded-full bg-surface px-2.5 text-xs leading-6 text-muted-foreground"
              >
                {t.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <CardHeart storyId={story.id} title={story.title} overPicture={!!media} />
    </article>
  );
}
