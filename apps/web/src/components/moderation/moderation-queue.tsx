'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess, WRAPPING_BUTTON } from '@/components/admin/admin-access';
import { Button } from '@/components/ui/button';
import type { ApiUser } from '@/lib/api-user';
import {
  FORMAT_LABEL,
  moderationProblem,
  type QueueItem,
  type QueuePage,
  sentAt,
} from './moderation-api';

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      items: QueueItem[];
      next: string | null;
      more?: 'loading' | string;
    };

/**
 * /moderation (M3 task 3.1): the stories waiting for review, oldest sent first, for Moderators
 * and up (api-admin checks it too, M3 plan concern C2). Each opens its review page; "Show more"
 * reads the next page. Read-only: picking a story up comes with the lock (a later PR).
 */
export function ModerationQueue({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl} min="Moderator">
      {(client) => <Queue client={client} />}
    </AdminAccess>
  );
}

function Queue({ client }: { client: ApiUser }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const load = useRef(0);

  const page = useCallback(
    (cursor: string | null) =>
      client
        .get<QueuePage>(
          `/v1/moderation/queue${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        )
        .then(({ data }) => {
          if (!data) throw new Error('No answer');
          return data;
        }),
    [client],
  );

  useEffect(() => {
    const mine = ++load.current;
    page(null).then(
      (p) => {
        if (load.current === mine)
          setLoaded({ status: 'ready', items: p.data, next: p.nextCursor });
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ status: 'failed', message: moderationProblem(err) });
      },
    );
  }, [page]);

  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the queue…</p>;
  }
  if (loaded.status === 'failed') {
    return (
      <p
        role="alert"
        className="rounded-2xl border border-destructive bg-card p-6"
        data-moderation-error=""
      >
        {loaded.message}
      </p>
    );
  }

  const more = () => {
    if (!loaded.next) return;
    const mine = load.current;
    setLoaded({ ...loaded, more: 'loading' });
    page(loaded.next).then(
      (p) => {
        if (load.current === mine)
          setLoaded({
            status: 'ready',
            items: [...loaded.items, ...p.data],
            next: p.nextCursor,
          });
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ ...loaded, more: moderationProblem(err) });
      },
    );
  };

  if (loaded.items.length === 0) {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-queue-empty=""
      >
        No stories are waiting for review.
      </p>
    );
  }
  return (
    <section aria-labelledby="queue-heading">
      <h2 id="queue-heading" className="sr-only">
        Waiting for review, oldest first
      </h2>
      <ol className="space-y-3" data-queue="">
        {loaded.items.map((s) => (
          <li key={s.id}>
            <Link
              href={`/moderation/${encodeURIComponent(s.id)}`}
              className="block min-h-11 rounded-2xl border border-border bg-card p-4 text-foreground no-underline [overflow-wrap:anywhere] hover:border-teal sm:p-5"
              data-queue-item={s.id}
            >
              <span className="block text-lg font-semibold">{s.title}</span>
              <span className="mt-1 block text-sm text-secondary-text">
                {FORMAT_LABEL[s.primaryFormat]} · sent{' '}
                <time dateTime={s.submittedAt}>{sentAt(s.submittedAt)}</time>
              </span>
              {s.mediaProblem === 'ours' && (
                // Part 1a: our own give-ups, never the person's file; they still see "Waiting".
                <span
                  className="mt-2 block text-sm font-semibold text-secondary-text"
                  data-queue-problem="ours"
                >
                  Can’t be reviewed yet: a problem on our side
                </span>
              )}
            </Link>
          </li>
        ))}
      </ol>
      {loaded.next && (
        <div className="mt-6 space-y-3">
          {loaded.more && loaded.more !== 'loading' && (
            <p role="alert" className="text-destructive">
              {loaded.more}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className={WRAPPING_BUTTON}
            disabled={loaded.more === 'loading'}
            onClick={more}
          >
            {loaded.more === 'loading' ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}
    </section>
  );
}
