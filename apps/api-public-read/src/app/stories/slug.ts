import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '@heisreal/http';

/** A story slug (`components.yaml#/components/parameters/storySlug`), at most 200 characters. */
export function isSlug(slug: string): boolean {
  return slug.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/** Unknown, malformed or unpublished: the same `404` (D30). */
export const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'story_not_found',
    'Story not found',
  );
