import type { StorySummary } from './browse';

// A story card's top line ("Video · 0:12", "Written · 3 min read"): story-card.tsx shows it, and
// lib/masonry.ts measures it to know whether the person's name still fits beside it.

/** About 1,000 characters a minute (200 words of 5 letters). */
const CHARS_PER_MINUTE = 1000;

export const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export const readingMinutes = (chars: number) =>
  Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE));

export function cardLabel(story: StorySummary): string {
  if (story.primaryFormat === 'written')
    return `Written · ${readingMinutes(story.textLength)} min read`;
  const kind = story.primaryFormat === 'video' ? 'Video' : 'Audio';
  return story.durationSeconds
    ? `${kind} · ${formatDuration(story.durationSeconds)}`
    : kind;
}
