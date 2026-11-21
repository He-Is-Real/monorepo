import { Suspense } from 'react';
import {
  PLAYER_ALLOW,
  PLAYER_MIN_HEIGHT,
  playerSrc,
} from '@/components/stories/story-media';
import { notKept } from '@/lib/page-cache';
import { type SiteVideoKey, siteVideoLink } from '@/lib/site-videos';

type Props = {
  videoKey: SiteVideoKey;
  /** The frame's accessible name, "Video: …". */
  title: string;
  /** What the placeholder says the video is. */
  label: string;
  /** Rendered for the page's saved copy (lib/page-cache.ts). */
  keep: boolean;
};

/**
 * One of the site's own videos (the founder's on About and Next Steps): Bunny's player with a
 * signed link from api-public-read (D52, a site video in the `site-assets` collection), the same
 * player as a story's. The page doesn't wait for the link (up to 5 s, lib/site-videos.ts): it
 * streams with the placeholder in the video's place, and the server sends the player when the
 * link arrives. If none is set for this environment, or api-public-read fails or is too slow,
 * the placeholder stays. The page renders per request, or comes from a saved copy far younger than
 * the link (page-cache.config.ts; the link lasts hours, D52). A saved copy is never kept when the
 * lookup failed (only when none is set): the visitor gets the placeholder, and the next visit asks
 * again.
 */
export function SiteVideo(props: Props) {
  return (
    <Suspense fallback={<Placeholder label={props.label} />}>
      <Player {...props} />
    </Suspense>
  );
}

async function Player({ videoKey, title, label, keep }: Props) {
  const link = await siteVideoLink(videoKey);
  if (link === 'unavailable' && keep) notKept();
  const src = typeof link === 'object' ? playerSrc(link.playbackUrl) : null;
  if (!src) return <Placeholder label={label} />;
  return (
    <div
      data-player=""
      className="relative aspect-video w-full overflow-hidden rounded-2xl bg-media"
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

function Placeholder({ label }: { label: string }) {
  return (
    <div
      data-video-placeholder=""
      className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-2xl bg-media px-4 text-center text-on-media/70"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-12 opacity-50 sm:size-16"
      >
        <polygon points="8,5 19,12 8,19" fill="currentColor" />
      </svg>
      <p className="text-sm">{label}</p>
      <p className="text-xs text-on-media/60">Video coming soon</p>
    </div>
  );
}
