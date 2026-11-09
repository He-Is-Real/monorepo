import Image from 'next/image';
import Link from 'next/link';
import type { StorySummary } from '@/lib/browse';
import { cardLabel } from '@/lib/card-label';
import { CARD_CSS } from '@/lib/card-metrics';
import { CARD_TOP_CSS } from '@/lib/masonry';
import { audioSize, cardAspect } from '@/lib/shape';
import { CardPlayer } from './card-player';
import { CardHeart } from './heart-button';
import { PLAYER_MIN_HEIGHT, playerSrc } from './story-media';

// A story's card (browse, home, related). Its sizes come from lib/card-metrics.ts (custom
// properties, `--card-…`), which lib/masonry.ts predicts its height from (D55); its parts mirror
// that prediction, so change them together. Its text is drawn without hinting
// (`geometricPrecision`): Chromium on Linux would otherwise round each letter to whole pixels,
// wider than the font's own widths the masonry wraps text with (lib/card-glyphs.ts). The card's
// one link is its title, stretched over the whole card, so the link's name is the story's title
// and themes stay plain text. On video and audio cards the media area is Bunny's player
// (card-player.tsx), so the link covers only the text below it. No counts or metrics of any kind
// (design principles). The person's heart sits at the end of the card's top line (the NEW · label
// · name row), never over the media (Joel, 2026-11-09), in room the line keeps for it, so it never
// changes the card's height; it fills in from the browser (heart-button.tsx, D83).

/** Home's uniform media box (the mockup's 16:10). */
const UNIFORM_ASPECT = 16 / 10;

// Quiet placeholders from the mockups, for a card without a signed picture or player: home's
// written stories without an image, or any card while signing is off.
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

/**
 * D72: "NEW" while the story is less than 7 days old (`story.isNew`, decided on web's server).
 * The mockup's teal pill on the site's tokens: the link-hover teal on a teal tint (about 6:1 in
 * both themes). It sits in the card's top line, at its 20 px height, so it never covers the
 * picture or the player, and the masonry's predicted heights stay right. Words,
 * not colour alone: screen readers hear "New: published in the last week".
 */
export function NewBadge() {
  return (
    <span
      data-new-badge=""
      className="inline-flex h-(--card-badge-line) shrink-0 items-center rounded-full bg-teal/15 px-(--card-badge-pad) text-(length:--card-badge-font) leading-(--card-badge-line) font-semibold tracking-(--card-badge-tracking) text-link-hover dark:bg-teal/20"
    >
      <CardMetrics />
      <span aria-hidden="true">NEW</span>
      <span className="sr-only">New: published in the last week</span>
    </span>
  );
}

/** The card's sizes (CARD_CSS): React puts them in the page's head, once. */
const CardMetrics = () => (
  <style href="story-card" precedence="default">
    {CARD_CSS + CARD_TOP_CSS}
  </style>
);

/**
 * A card's picture and its clamped shape (D53), as browse shows it; null for a written story
 * without an image (home's `uniform` gives it a 16:10 placeholder instead). A video or audio
 * card shows its player in a box of this shape; the picture is only Related's small list's.
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
  const player =
    playable && story.playbackUrl ? playerSrc(story.playbackUrl) : null;

  const placeholder = (
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
  );

  let mediaBox = null;
  if (media && player && playable)
    mediaBox = (
      <CardPlayer
        src={player}
        title={story.title}
        format={format}
        aspect={aspect}
      />
    );
  else if (media)
    // A written story's picture; or, while signing is off, the placeholder in the player's box.
    mediaBox = (
      <div
        data-card-media=""
        className="relative w-full shrink-0 overflow-hidden bg-surface"
        style={{
          aspectRatio: String(aspect),
          ...(playable && { minHeight: PLAYER_MIN_HEIGHT, minWidth: 0 }),
        }}
      >
        {media.src && !playable ? (
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
          placeholder
        )}
      </div>
    );

  const top = (
    <p className="mb-(--card-meta-after) flex flex-wrap items-center justify-between gap-x-(--card-meta-gap) gap-y-(--card-meta-row-gap) pr-(--card-meta-heart) text-(length:--card-meta-font) leading-(--card-meta-line) text-muted-foreground">
      <span
        data-card-label=""
        className="flex max-w-full flex-wrap items-center gap-x-(--card-badge-after) gap-y-(--card-meta-row-gap)"
      >
        {story.isNew && <NewBadge />}
        {cardLabel(story)}
      </span>
      <span className="min-w-0 flex-1 basis-(--card-meta-name) truncate text-right">
        {story.bylineName ?? 'Anonymous'}
      </span>
    </p>
  );

  return (
    <article className="story-card group relative flex h-full flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border transition-[box-shadow,background-color] [overflow-wrap:anywhere] [text-rendering:geometricPrecision] hover:ring-border-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <CardMetrics />
      {mediaBox}
      <div
        className={`flex flex-1 flex-col p-(--card-pad) ${player && media ? 'relative' : ''}`}
      >
        {/* One line at normal text sizes, with room for the heart at its end: the name shortens with
            "…" first. It moves to its own line only when under 2.5rem would be left, and with large
            text the label wraps too, so nothing is ever clipped by the card. A NEW card too narrow
            for the badge beside the heart moves the line below the heart (lib/masonry.ts's
            CARD_TOP_CSS). */}
        <div className={`relative ${story.isNew ? 'card-top' : ''}`}>
          {top}
          <CardHeart storyId={story.id} title={story.title} />
        </div>
        <Heading className="mb-(--card-title-after) line-clamp-(--card-title-lines) text-(length:--card-title-font) leading-(--card-title-line) font-semibold">
          <Link
            href={`/stories/${story.slug}`}
            // No prefetch: a story's page reads the whole story from api-public-read; it is read
            // only for stories someone opens.
            prefetch={false}
            className="text-foreground outline-none after:absolute after:inset-0 after:content-[''] hover:text-foreground"
          >
            {story.title}
          </Link>
        </Heading>
        {quote ? (
          <blockquote className="line-clamp-(--card-quote-lines) border-l-(length:--card-quote-border) border-teal pl-(--card-quote-pad) text-(length:--card-quote-font) leading-(--card-quote-line) text-secondary-text">
            {story.excerpt}
          </blockquote>
        ) : (
          <p className="line-clamp-(--card-excerpt-lines) text-(length:--card-excerpt-font) leading-(--card-excerpt-line) text-secondary-text italic">
            {story.excerpt}
          </p>
        )}
        {story.themes.length > 0 && (
          <ul
            className="mt-(--card-themes-before) flex flex-wrap gap-(--card-themes-gap)"
            aria-label="Themes"
          >
            {story.themes.map((t) => (
              <li
                key={t.id}
                className="h-(--card-themes-row) truncate rounded-full bg-surface px-(--card-themes-pad) text-(length:--card-themes-font) leading-(--card-themes-row) text-muted-foreground"
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
