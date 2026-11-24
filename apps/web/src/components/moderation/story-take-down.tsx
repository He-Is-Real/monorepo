'use client';

import { type ReactNode, useMemo, useRef, useEffect, useState } from 'react';
import { useRole } from '@/components/admin/admin-access';
import { Button, Card, Heading, Notice } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';
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
  | { step: 'open'; story: ModerationStory; busy: boolean; refusal?: ReactNode }
  | { step: 'done' }
  | { step: 'problem'; message: ReactNode };

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
    <Card
      asChild
      className="mx-auto mt-12 w-full max-w-measure min-w-0 p-4 sm:p-6"
    >
      <section
        aria-labelledby="take-down-heading"

        data-take-down=""
      >
        <Heading level={2} size="sub" id="take-down-heading" className="mb-4">
          For moderators
        </Heading>
        {(state.step === 'closed' || state.step === 'opening') && (
          <Button
            variant="outline"
            wrap
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
              <Notice
                kind="warning"
                as="p"
                role="alert"
                className="mt-4"
                data-decision-refused=""
              >
                {state.refusal}
              </Notice>
            )}
          </>
        )}
        {(state.step === 'done' || state.step === 'problem') && (
          <>
            <Notice
              kind={state.step === 'done' ? 'success' : 'danger'}
              as="p"
              ref={doneRef}
              tabIndex={-1}
              role="status"
              className="outline-none"
              data-take-down-notice={state.step}
            >
              <strong>
                {state.step === 'done' ? DONE.hide : state.message}
              </strong>
            </Notice>
            <p className="mt-2">
              <TextLink kind="standalone" href={review}>
                Open its review page
              </TextLink>
            </p>
          </>
        )}
      </section>
    </Card>
  );
}
