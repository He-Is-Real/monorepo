'use client';

import { useCallback } from 'react';
import { PreviewLater, ownStoryContent } from '@/components/share/own-media';
import type { MyStory } from '@/components/share/share-api';
import { published, StoryArticle } from '@/components/stories/story-view';
import { type ApiUser, ApiUserProblem } from '@/lib/api-user';
import { signInHref } from '@/lib/return-path';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import { useOwnData } from './use-own-data';
import {
  Card,
  TextLink as LibraryTextLink,
  Notice,
  Text,
} from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

type Read = { story: MyStory } | { gone: true };

/**
 * "See your story preview" (M3 plan PR 2, part 1b B; Joel, 2026-11-10, P1b-1 C): the
 * person's own story through the public story page's parts (`StoryArticle`), with a banner that
 * only they can see it, and no heart, share or related stories. Read from api-user in the browser
 * (D83) with their own token: GetStory answers only the owner (404 for anyone else), with their
 * video or audio signed for an hour once Bunny has processed it; until then the player's place
 * says to check back later.
 */
export function OwnStoryPreview({ id }: { id: string }) {
  const read = useCallback(
    async (api: ApiUser): Promise<Read> => {
      try {
        const { data } = await api.get<MyStory>(
          `/v1/account/stories/${encodeURIComponent(id)}`,
        );
        if (!data) throw new Error('No story in the answer');
        return { story: data };
      } catch (err) {
        if (err instanceof ApiUserProblem && err.status === 404)
          return { gone: true };
        throw err;
      }
    },
    [id],
  );
  const { state } = useOwnData(read);

  if (state.status === 'signed-out') {
    return (
      <Card asChild className="p-6">
        <p>
          <LibraryTextLink
            touch
            href={signInHref(
              `/account/stories/${encodeURIComponent(id)}/preview`,
            )}
          >
            Sign in
          </LibraryTextLink>{' '}
          to see your story’s preview.
        </p>
      </Card>
    );
  }
  if (state.status === 'loading') {
    return (
      <div aria-busy="true" className="min-h-48">
        <p className="sr-only" role="status">
          Loading your story…
        </p>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <Notice kind="danger" as="p" role="alert" data-preview-error="">
        {TRY_AGAIN_LATER}
      </Notice>
    );
  }
  if ('gone' in state.data) {
    return (
      <Card asChild className="p-6">
        <p data-preview-gone="">
          This story isn’t available. It may have been deleted, or it belongs to
          another account.{' '}
          <TextLink href="/account" touch>
            Back to your profile
          </TextLink>
        </p>
      </Card>
    );
  }
  const { story } = state.data;
  const when = story.approvedAt ?? story.submittedAt;
  return (
    <>
      <Notice
        kind="info"
        data-preview-banner=""
        className="mx-auto mb-8 max-w-measure"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Text weight="bold">Only you can see this preview</Text>
          <TextLink href="/account" kind="standalone">
            Back to your profile
          </TextLink>
        </div>
      </Notice>
      <PreviewLater story={story} className="mx-auto mb-6 max-w-measure" />
      <StoryArticle
        story={ownStoryContent(story)}
        dateLine={
          when ? (
            <>
              {story.approvedAt ? 'Shared' : 'Sent for review'}{' '}
              <time dateTime={when}>{published(when)}</time>
            </>
          ) : (
            'Not sent yet'
          )
        }
      />
    </>
  );
}
