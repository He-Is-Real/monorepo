import Image from 'next/image';
import type { CSSProperties } from 'react';
import { imageAlt } from '@/lib/shape';
import type { PublicStory } from '@/lib/public-stories';

// D52: api-public-read signs every media link (Bunny token auth); web shows them as given.
// Pages render per request (`no-store`), so a page never holds a link older than the API's.
// No autoplay (design principle): the player is told so, and `allow` grants no autoplay.

export const PLAYER_ALLOW = 'encrypted-media; picture-in-picture; fullscreen';
/**
 * The shortest box Bunny's player fits its controls in (AGENTS.md: 44 px targets). Below about
 * 176 px its button row is squeezed and the 44 px buttons spill out of the frame, whatever the
 * width (measured on dev's real player, #77 review). A few pixels to spare.
 */
export const PLAYER_MIN_HEIGHT = 184;

/**
 * The signed player URL with autoplay and preload off, or `null` if it isn't http(s). A card's
 * player (card-player.tsx) asks for `autoplay`: it opens only when someone presses play.
 */
export function playerSrc(
  playbackUrl: string,
  { autoplay = false }: { autoplay?: boolean } = {},
): string | null {
  let url: URL;
  try {
    url = new URL(playbackUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The token covers only the video and expiry, so player options can be added.
  url.searchParams.set('autoplay', String(autoplay));
  url.searchParams.set('preload', String(autoplay));
  return url.toString();
}

/** A story's player (video, audio) or image, above its text. Nothing without a signed URL. */
export function StoryMedia({ story }: { story: PublicStory }) {
  const media = story.media?.[0]; // `media` may be absent (isPublicStory allows it)
  const src = media?.playbackUrl ? playerSrc(media.playbackUrl) : null;
  if (media && src) {
    const isVideo = media.format === 'video';
    // Video keeps its real shape, no taller than most of the screen; audio gets a bar.
    const shaped = isVideo && media.width && media.height;
    // Never shorter than the player's controls need (a very wide video on a phone).
    const style: CSSProperties = shaped
      ? {
          aspectRatio: `${media.width} / ${media.height}`,
          width: `min(100%, calc(75svh * ${media.width} / ${media.height}))`,
          minHeight: PLAYER_MIN_HEIGHT,
          minWidth: 0, // or aspect-ratio turns the min-height into a wider minimum width
        }
      : { minHeight: PLAYER_MIN_HEIGHT };
    return (
      <div
        data-player=""
        data-story-media=""
        className={`relative mx-auto mt-6 overflow-hidden rounded-lg bg-black ${
          isVideo ? (shaped ? '' : 'aspect-video w-full') : 'w-full'
        }`}
        style={style}
      >
        <iframe
          src={src}
          title={`${isVideo ? 'Video' : 'Audio'}: ${story.title}`}
          allow={PLAYER_ALLOW}
          allowFullScreen
          loading="lazy"
          className="absolute inset-0 block h-full w-full border-0"
        />
      </div>
    );
  }
  const image = story.image;
  if (image?.url) {
    return (
      <Image
        data-story-media=""
        src={image.url}
        alt={imageAlt(image)}
        width={image.width}
        height={image.height}
        unoptimized
        className="mx-auto mt-6 h-auto max-h-[75svh] w-auto max-w-full rounded-lg object-contain"
      />
    );
  }
  return null;
}
