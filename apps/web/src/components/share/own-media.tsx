import { StoryMedia } from '@/components/stories/story-media';
import type { StoryContent } from '@/components/stories/story-view';
import type { MyStory } from './share-api';

/**
 * The person's own story as the story page's parts show it (M3 plan PR 2, part 1b): their video
 * or audio in Bunny's player once api-user has signed it for them (GetStory only: an hour), their
 * picture, words and themes.
 */
export function ownStoryContent(story: MyStory): StoryContent {
  return {
    id: story.id,
    title: story.title,
    description: story.description,
    body: story.body,
    bylineName: story.bylineName,
    primaryFormat: story.primaryFormat,
    media: story.media.map((m) => ({
      format: m.format,
      playbackUrl: m.playbackUrl ?? null,
      thumbnailUrl: m.thumbnailUrl ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      captionsUrl: null,
      durationSeconds: m.durationSeconds ?? null,
    })),
    image: story.image,
    themes: story.themes,
  };
}

/**
 * Where the player would be while Bunny hasn't finished with the file (Joel, 2026-11-10): no
 * waiting, no checking again; the person can still send the story or keep it as a draft.
 * Nothing for a written story, or once the player has its link.
 */
export function PreviewLater({
  story,
  className = '',
}: {
  story: MyStory;
  className?: string;
}) {
  const media = story.media[0];
  if (!media || media.playbackUrl) return null;
  return (
    <p
      data-preview-later={media.format}
      className={`rounded-xl bg-surface px-4 py-3 text-secondary-text ${className}`}
    >
      Check back later for your {media.format === 'audio' ? 'audio' : 'video'}{' '}
      preview.
    </p>
  );
}

/** The share flow's quick look: the player once it's ready, else {@link PreviewLater}. */
export function OwnMediaPreview({ story }: { story: MyStory }) {
  if (story.media[0]?.playbackUrl) {
    return (
      <div data-own-player="" className="max-w-xl">
        <StoryMedia story={ownStoryContent(story)} />
      </div>
    );
  }
  return <PreviewLater story={story} />;
}

/** The "see it as others will" page (owner only). */
export const previewHref = (id: string) =>
  `/account/stories/${encodeURIComponent(id)}/preview`;
