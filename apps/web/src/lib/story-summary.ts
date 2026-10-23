import type { StorySummary, StoryTag } from './browse';
import type { PublicStory } from './public-stories';

/** A card's story: the API's `StorySummary`, or one made from a full story (tags by name only). */
export type CardStory = Omit<StorySummary, 'tags'> & {
  tags: Pick<StoryTag, 'slug' | 'name'>[];
};

const EXCERPT_MAX_CHARS = 240;

/** One line of at most 240 characters, cut at a word, then `…` (the API's card excerpt). */
export function excerptOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  if (chars.length <= EXCERPT_MAX_CHARS) return line;
  const head = chars.slice(0, EXCERPT_MAX_CHARS + 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head.slice(0, -1)).trimEnd()}…`;
}

/** A card for a story fetched whole (home's featured story). Never carries the player link. */
export function summaryFromStory(story: PublicStory): CardStory {
  const media = story.media?.[0];
  return {
    id: story.id,
    slug: story.slug,
    title: story.title,
    excerpt: excerptOf(story.description || story.body || ''),
    bylineName: story.bylineName,
    primaryFormat: story.primaryFormat,
    durationSeconds: media?.durationSeconds ?? null,
    thumbnailUrl: media?.format === 'video' ? media.thumbnailUrl : null,
    thumbnailWidth: media?.format === 'video' ? media.width : null,
    thumbnailHeight: media?.format === 'video' ? media.height : null,
    image: story.image,
    textLength: [...(story.body ?? '')].length,
    tags: story.tags.map(({ slug, name }) => ({ slug, name })),
    publishedAt: story.publishedAt,
  };
}
