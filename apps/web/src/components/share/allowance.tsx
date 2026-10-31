import type { SubmissionLimits } from './share-api';

/**
 * What the person has left this week, from `GET /v1/account/limits` (D94, D113): stories to send
 * for review and video or audio uploads (pictures never count), said before they reach a limit,
 * so the share page can explain and hold back a step instead of answering it with an error.
 * "This week" is the rolling 7 days the limits count.
 */

/** Left of the weekly allowance; null when there's no weekly limit (a trusted submitter). */
export function weekLeft(
  per7Days: number | null,
  usedIn7Days: number,
): { left: number; of: number } | null {
  return per7Days === null
    ? null
    : { left: Math.max(0, per7Days - usedIn7Days), of: per7Days };
}

/** When the person may next do it, if that's later than now. */
export function waitUntil(at: string | null): Date | null {
  if (!at) return null;
  const when = new Date(at);
  return when.getTime() > Date.now() ? when : null;
}

const whenFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Europe/London',
});
/** "Tuesday 4 November at 14:30". */
export const formatWhen = (d: Date) => whenFormat.format(d);

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Stories for review: left this week, or when the next one may go. */
export function submissionsState(limits: SubmissionLimits) {
  const week = weekLeft(
    limits.submissions.per7Days,
    limits.submissions.usedIn7Days,
  );
  const until = waitUntil(limits.submissions.nextAvailableAt);
  return { week, until: week ? until : null };
}

/** Video and audio uploads: left this week, and when the next may start if not now. */
export function uploadsState(limits: SubmissionLimits['uploads']) {
  const week = weekLeft(limits.per7Days, limits.usedIn7Days);
  const until = waitUntil(limits.nextAvailableAt);
  /** Waiting on the weekly count (else the hourly one). */
  const weekly = !!week && week.left === 0;
  return { week, until, weekly };
}

export function SubmissionsLeft({
  limits,
  id,
}: {
  limits: SubmissionLimits;
  id?: string;
}) {
  const { week, until } = submissionsState(limits);
  if (!week) return null;
  if (until) {
    return (
      <p id={id} data-allowance="submissions" className="text-foreground">
        You’ve sent{' '}
        {week.of === 1 ? 'your story' : plural(week.of, 'story', 'stories')} for
        review this week, which is all for now. You can send another from{' '}
        {formatWhen(until)}. Until then, you’re welcome to keep writing: it’s
        saved as a draft.
      </p>
    );
  }
  return (
    <p id={id} data-allowance="submissions">
      <strong>
        {week.left} of {week.of}
      </strong>{' '}
      {week.of === 1 ? 'story' : 'stories'} left to send for review this week.
    </p>
  );
}

export function UploadsLeft({
  limits,
  noun,
  id,
}: {
  limits: SubmissionLimits['uploads'];
  /** "video", "audio file". */
  noun: string;
  id?: string;
}) {
  const { week, until, weekly } = uploadsState(limits);
  if (until) {
    return (
      <p id={id} data-allowance="uploads" className="text-foreground">
        {weekly && week
          ? `You’ve used this week’s ${plural(week.of, 'upload', 'uploads')}, which is all for now.`
          : 'You’ve started quite a few uploads in the last hour.'}{' '}
        You can upload your {noun} from {formatWhen(until)}. Anything you’ve
        saved stays saved.
      </p>
    );
  }
  if (!week) return null;
  return (
    <p id={id} data-allowance="uploads">
      <strong>
        {week.left} of {week.of}
      </strong>{' '}
      video or audio uploads left this week.
    </p>
  );
}
