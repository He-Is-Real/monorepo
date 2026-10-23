import Image from 'next/image';
import type { CSSProperties } from 'react';
import { imageAlt } from '@/lib/shape';
import type { PublicStory } from '@/lib/public-stories';

// D52: api-public-read signs every media link (Bunny token auth); web shows them as given.
// Pages render per request (`no-store`), so a page never holds a link older than the API's.
// No autoplay (design principle): the player is told so, and `allow` grants no autoplay.

const PLAYER_ALLOW = 'encrypted-media; picture-in-picture; fullscreen';

/** The signed player URL with autoplay and preload off, or `null` if it isn't http(s). */
export function playerSrc(playbackUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(playbackUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The token covers only the video and expiry, so player options can be added.
  url.searchParams.set('autoplay', 'false');
  url.searchParams.set('preload', 'false');
  return url.toString();
}

/** A story's player (video, audio) or image, above its text. Nothing without a signed URL. */
export function StoryMedia({ story }: { story: PublicStory }) {
  const media = story.media?.[0]; // `media` may be absent (isPublicStory allows it)
  const src = media?.playbackUrl ? playerSrc(media.playbackUrl) : null;
  if (media && src) {
    const isVideo = media.format === 'video';
    // Video keeps its real shape, no taller than most of the screen; audio gets a short bar.
    const style: CSSProperties | undefined =
      isVideo && media.width && media.height
        ? {
            aspectRatio: `${media.width} / ${media.height}`,
            width: `min(100%, calc(75svh * ${media.width} / ${media.height}))`,
          }
        : undefined;
    return (
      <div
        className={`mx-auto mt-6 overflow-hidden rounded-lg bg-black ${
          isVideo ? (style ? '' : 'aspect-video w-full') : 'h-40 w-full'
        }`}
        style={style}
      >
        <iframe
          src={src}
          title={`${isVideo ? 'Video' : 'Audio'}: ${story.title}`}
          allow={PLAYER_ALLOW}
          allowFullScreen
          loading="lazy"
          className="block h-full w-full border-0"
        />
      </div>
    );
  }
  const image = story.image;
  if (image?.url) {
    return (
      <Image
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
