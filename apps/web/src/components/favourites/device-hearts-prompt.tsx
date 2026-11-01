'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { deviceHeartCards } from '@/app/stories/actions';
import { useAccountState } from '@/components/auth/account-bootstrap';
import { Button } from '@/components/ui/button';
import { MAX_IDS } from '@/lib/browse';
import {
  deviceHeartIdsToOffer,
  markAddedToAccount,
  onDeviceHearts,
} from '@/lib/device-hearts';
import { addHeartsToAccount } from '@/lib/favourites';
import { usePersonalSession } from '@/lib/personal-session';

/** People who said "Not now" on this page load: asked again on the next one. */
const notNow = new Set<string>();

const chunks = (ids: readonly string[]) =>
  Array.from({ length: Math.ceil(ids.length / MAX_IDS) }, (_, i) =>
    ids.slice(i * MAX_IDS, (i + 1) * MAX_IDS),
  );

/**
 * Hearts kept on this device, offered to the account (Joel, 2026-10-28; the assumption in #117):
 * once someone is signed in and has agreed to the latest terms of use (plan 4e), if this device keeps
 * hearts on public stories that haven't been added to an account from it yet, a small prompt
 * asks "Add the N stories you hearted on this device to your account?" with Add and Not now.
 *
 * - **Nothing reaches api-user before Add** (Codex, #117 round 4): the count is the public
 *   stories among them, from the anonymous card lookup (web's server, api-public-read), never
 *   from the person's account. Add's saves are idempotent, so stories already in the account
 *   are simply saved again.
 * - **Nothing is added without Add** (a shared device's hearts may be someone else's: Codex,
 *   #117 round 1). Add saves them like presses, as the person who pressed it only.
 * - The device's list stays as it is; hearts added are marked, so they aren't offered again. If
 *   some couldn't be added, the prompt stays, offering those, and says so.
 * - Not now asks again on the next page load. Fixed at the bottom of the screen, so nothing on
 *   the page moves.
 */
export function DeviceHeartsPrompt() {
  const session = usePersonalSession();
  const userId = session.status === 'signed-in' ? session.userId : null;
  // The header's account bootstrap says whether the latest terms of use are agreed (plan 4e).
  const bootstrap = useAccountState(userId);
  const accepted =
    bootstrap.status === 'ready' && bootstrap.account.termsOfUse.upToDate;
  const [deviceVersion, setDeviceVersion] = useState(0);
  const [offer, setOffer] = useState<{ owner: string; ids: string[] } | null>(
    null,
  );
  const [adding, setAdding] = useState<'idle' | 'adding' | 'failed'>('idle');
  const [done, setDone] = useState('');
  const headingId = useId();
  /**
   * The person whose Add result is on screen (some couldn't be added): marking the ones that
   * were added changes the device's list, which must not wipe the result and its Try again
   * (Codex, #117 round 5).
   */
  const showingResultFor = useRef<string | null>(null);

  useEffect(() => {
    const stop = onDeviceHearts(() => setDeviceVersion((v) => v + 1));
    return () => {
      stop();
    };
  }, []);

  useEffect(() => {
    if (
      showingResultFor.current !== null &&
      showingResultFor.current === userId
    )
      return;
    showingResultFor.current = null;
    setOffer(null);
    setAdding('idle');
    if (!userId || !accepted || notNow.has(userId)) return;
    const ids = deviceHeartIdsToOffer();
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const offered: string[] = [];
      for (const chunk of chunks(ids)) {
        const cards = await deviceHeartCards(chunk);
        if (!cards.ok) return; // can't tell now: no prompt this time
        const isPublic = new Set(cards.cards.map((c) => c.id));
        offered.push(...chunk.filter((id) => isPublic.has(id)));
      }
      if (!cancelled && offered.length > 0)
        setOffer({ owner: userId, ids: offered });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // deviceVersion: the device's list changed (here or in another tab).
  }, [userId, accepted, deviceVersion]);

  if (!offer || offer.owner !== userId)
    return (
      <p role="status" className="sr-only">
        {done}
      </p>
    );

  const count = offer.ids.length;
  const add = async () => {
    setAdding('adding');
    const { added, failed } = await addHeartsToAccount(offer.ids);
    if (failed.length > 0) {
      showingResultFor.current = offer.owner; // before marking: keep this result on screen
      markAddedToAccount(added);
      setOffer({ owner: offer.owner, ids: failed });
      setAdding('failed');
      return;
    }
    showingResultFor.current = null;
    markAddedToAccount(added);
    setAdding('idle');
    setOffer(null);
    setDone(
      count === 1
        ? 'Added the story to your account.'
        : `Added ${count} stories to your account.`,
    );
  };

  return (
    <section
      data-device-hearts-prompt=""
      aria-labelledby={headingId}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto mx-auto w-full max-w-[32rem] rounded-2xl border border-border-hover bg-card p-4 text-card-foreground shadow-2xl">
        <p id={headingId} aria-live="polite" className="text-[0.9375rem]">
          {count === 1
            ? 'Add the story you hearted on this device to your account?'
            : `Add the ${count} stories you hearted on this device to your account?`}
        </p>
        {adding === 'failed' && (
          <p role="alert" className="mt-2 text-sm text-secondary-text">
            {count === 1
              ? 'It couldn’t be added. Try again in a moment.'
              : 'Some couldn’t be added. Try again in a moment.'}
          </p>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            className="h-11 px-4"
            onClick={() => {
              if (userId) notNow.add(userId);
              showingResultFor.current = null;
              setOffer(null);
            }}
          >
            Not now
          </Button>
          <Button
            className="h-11 px-4"
            onClick={add}
            disabled={adding === 'adding'}
          >
            {adding === 'adding'
              ? 'Adding…'
              : adding === 'failed'
                ? 'Try again'
                : 'Add'}
          </Button>
        </div>
      </div>
    </section>
  );
}
