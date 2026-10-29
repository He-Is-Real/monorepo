import {
  PLAYER_ALLOW,
  PLAYER_MIN_HEIGHT,
  playerSrc,
} from '@/components/stories/story-media';
import { type SiteVideoKey, siteVideoUrl } from '@/lib/site-videos';

/**
 * One of the site's own videos (the founder's on About and Next Steps): Bunny's player with a
 * signed link from api-public-read (D52, a site video in the `site-assets` collection), the same
 * player as a story's. Until a video is set for this environment, or if api-public-read can't be
 * reached, a placeholder. The page must render per request (`connection()`): the link expires.
 */
export async function SiteVideo({
  videoKey,
  title,
  label,
}: {
  videoKey: SiteVideoKey;
  /** The frame's accessible name, "Video: …". */
  title: string;
  /** What the placeholder says the video is. */
  label: string;
}) {
  const playbackUrl = await siteVideoUrl(videoKey);
  const src = playbackUrl ? playerSrc(playbackUrl) : null;
  if (src) {
    return (
      <div
        data-player=""
        className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black"
        style={{ minHeight: PLAYER_MIN_HEIGHT }}
      >
        <iframe
          src={src}
          title={title}
          allow={PLAYER_ALLOW}
          allowFullScreen
          className="absolute inset-0 block h-full w-full border-0"
        />
      </div>
    );
  }
  return (
    <div
      data-video-placeholder=""
      className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-2xl bg-black px-4 text-center text-white/70"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-12 opacity-50 sm:size-16"
      >
        <polygon points="8,5 19,12 8,19" fill="currentColor" />
      </svg>
      <p className="text-sm">{label}</p>
      <p className="text-xs text-white/60">Video coming soon</p>
    </div>
  );
}
