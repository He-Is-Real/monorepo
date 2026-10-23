import Image from 'next/image';
import Link from 'next/link';
import type { CardStory } from '@/lib/story-summary';
import { cardAspect } from '@/lib/shape';

// A story's card (browse, home, related). Its parts and sizes mirror lib/masonry.ts, which
// predicts its height (D55): change them together. The card's one link is its title, stretched
// over the whole card, so the link's name is the story's title and tags stay plain text.
// No counts or metrics of any kind (design principles).

/** Home's uniform media box (the mockup's 16:10). */
const UNIFORM_ASPECT = 16 / 10;
/** About 1,000 characters a minute (200 words of 5 letters). */
const CHARS_PER_MINUTE = 1000;

export const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export const readingMinutes = (chars: number) =>
  Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE));

// Quiet placeholders from the mockups, for media without a signed picture (audio, or signing off).
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

export function cardLabel(story: CardStory): string {
  if (story.primaryFormat === 'written')
    return `Written · ${readingMinutes(story.textLength)} min read`;
  const kind = story.primaryFormat === 'video' ? 'Video' : 'Audio';
  return story.durationSeconds
    ? `${kind} · ${formatDuration(story.durationSeconds)}`
    : kind;
}

function mediaOf(story: CardStory, uniform: boolean) {
  const { primaryFormat: format, image } = story;
  if (format === 'video')
    return {
      aspect: cardAspect(story.thumbnailWidth, story.thumbnailHeight),
      src: story.thumbnailUrl,
      width: story.thumbnailWidth,
      height: story.thumbnailHeight,
    };
  if (format === 'audio') return { aspect: 2, src: null };
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
  story: CardStory;
  /** Home: every card's media in the same 16:10 box, cropped. */
  uniform?: boolean;
  headingLevel?: 2 | 3;
  /** The first cards on screen: load their pictures straight away. */
  eager?: boolean;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const media = mediaOf(story, uniform);
  const quote = media === null; // a written story without an image
  const [from, to, accent] = placeholderFor(story.id);
  const initial = [
    ...(story.bylineName?.trim() || story.title),
  ][0]?.toUpperCase();

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border transition-[box-shadow,background-color] [overflow-wrap:anywhere] hover:ring-border-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      {media && (
        <div
          data-card-media=""
          className="relative w-full shrink-0 overflow-hidden bg-surface"
          style={{
            aspectRatio: String(uniform ? UNIFORM_ASPECT : media.aspect),
          }}
        >
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
          {story.primaryFormat !== 'written' && (
            <span
              aria-hidden="true"
              className="absolute right-3 bottom-3 flex size-11 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur-sm transition-transform group-hover:scale-105 motion-reduce:transition-none"
            >
              {story.primaryFormat === 'video' ? (
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
        </div>
      )}
      <div className="flex flex-1 flex-col p-5">
        <p className="mb-2 flex items-baseline justify-between gap-3 text-[13px] leading-5 text-muted-foreground">
          <span className="shrink-0">{cardLabel(story)}</span>
          <span className="truncate">{story.bylineName ?? 'Anonymous'}</span>
        </p>
        <Heading className="mb-1.5 line-clamp-3 text-[17px] leading-6 font-semibold">
          <Link
            href={`/stories/${story.slug}`}
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
          <p className="line-clamp-3 text-[15px] leading-6 text-secondary-text italic">
            {story.excerpt}
          </p>
        )}
        {story.tags.length > 0 && (
          <ul className="mt-3.5 flex flex-wrap gap-1.5" aria-label="Tags">
            {story.tags.map((t) => (
              <li
                key={t.slug}
                className="h-6 truncate rounded-full bg-surface px-2.5 text-xs leading-6 text-muted-foreground"
              >
                {t.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
