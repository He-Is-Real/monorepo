'use client';

import Link from 'next/link';
import { useMemo, useRef, useEffect, useState } from 'react';
import { useRole, WRAPPING_BUTTON } from '@/components/admin/admin-access';
import { Button } from '@/components/ui/button';
import { apiUser, type ApiUser } from '@/lib/api-user';
import { usePersonalSession } from '@/lib/personal-session';
import {
  decisionRefusal,
  DONE,
  type ModerationStory,
  moderationProblem,
} from './moderation-api';
import { NoteForm } from './moderation-review';

type State =
  | { step: 'closed' }
  | { step: 'opening' }
  | { step: 'open'; story: ModerationStory; busy: boolean; refusal?: string }
  | { step: 'done' }
  | { step: 'problem'; message: string };

/**
 * MD-1 (Joel, 2026-11-14): "Take down" on a published story's public page, for a signed-in
 * Moderator or Admin only. Everyone gets the same server-rendered page (it stays public and
 * cacheable); this part appears in the browser once the person's role is known, and renders
 * nothing for anyone else. It opens the review page's own take-down form (a reason is required)
 * and uses the same api-admin route, naming the story as api-admin answers it now (`reviewTag`).
 * Once taken down, the story leaves the site as from the review page.
 */
export function StoryTakeDown({
  storyId,
  apiAdminUrl,
}: {
  storyId: string;
  apiAdminUrl?: string;
}) {
  const role = useRole();
  const session = usePersonalSession();
  const getToken = session.status === 'signed-in' ? session.getToken : null;
  const client = useMemo(
    () => (getToken && apiAdminUrl ? apiUser(apiAdminUrl, getToken) : null),
    [getToken, apiAdminUrl],
  );
  if (!client || (role !== 'Moderator' && role !== 'Admin')) return null;
  return <TakeDown storyId={storyId} client={client} />;
}

function TakeDown({ storyId, client }: { storyId: string; client: ApiUser }) {
  const [state, setState] = useState<State>({ step: 'closed' });
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.step === 'done' || state.step === 'problem')
      doneRef.current?.focus();
  }, [state.step]);
  const review = `/moderation/${encodeURIComponent(storyId)}`;

  async function open() {
    setState({ step: 'opening' });
    try {
      const { data } = await client.get<ModerationStory>(
        `/v1/moderation/stories/${encodeURIComponent(storyId)}`,
      );
      if (!data) throw new Error('No answer');
      setState(
        data.status === 'approved'
          ? { step: 'open', story: data, busy: false }
          : {
              step: 'problem',
              message: 'This story isn’t on the site any more.',
            },
      );
    } catch (err) {
      setState({ step: 'problem', message: moderationProblem(err) });
    }
  }

  async function takeDown(story: ModerationStory, body: unknown) {
    setState({ step: 'open', story, busy: true });
    try {
      await client.command(
        `/v1/moderation/stories/${encodeURIComponent(story.id)}/hide`,
        { method: 'POST', body, tag: story.reviewTag },
      );
      setState({ step: 'done' });
    } catch (err) {
      const why = decisionRefusal(err, story, 'hide');
      setState(
        why.refresh
          ? { step: 'problem', message: why.message }
          : { step: 'open', story, busy: false, refusal: why.message },
      );
    }
  }

  return (
    <section
      aria-labelledby="take-down-heading"
      className="mx-auto mt-12 w-full max-w-measure min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6"
      data-take-down=""
    >
      <h2 id="take-down-heading" className="mb-4 text-xl font-semibold">
        For moderators
      </h2>
      {(state.step === 'closed' || state.step === 'opening') && (
        <Button
          variant="outline"
          className={WRAPPING_BUTTON}
          disabled={state.step === 'opening'}
          onClick={() => void open()}
        >
          Take down
        </Button>
      )}
      {state.step === 'open' && (
        <>
          <NoteForm
            kind="hide"
            busy={state.busy}
            onSubmit={(body) => void takeDown(state.story, body)}
            onCancel={() => setState({ step: 'closed' })}
          />
          {state.refusal && (
            <p role="alert" className="mt-4" data-decision-refused="">
              {state.refusal}
            </p>
          )}
        </>
      )}
      {(state.step === 'done' || state.step === 'problem') && (
        <>
          <p
            ref={doneRef}
            tabIndex={-1}
            role="status"
            className="font-semibold outline-none"
            data-take-down-notice={state.step}
          >
            {state.step === 'done' ? DONE.hide : state.message}
          </p>
          <p className="mt-2">
            <Link href={review} className="inline-flex min-h-11 items-center">
              Open its review page
            </Link>
          </p>
        </>
      )}
    </section>
  );
}
