import { act, renderHook } from '@testing-library/react';
import type { ApiUser, ApiUserResponse } from '@/lib/api-user';
import { shareApi } from './share-api';
import { useDraft } from './use-draft';

// Codex #118 round 4: a create that answers 201 with no body says nothing about the draft it
// made. The text, its Idempotency-Key and the exact body sent stay on this device, so the
// retry replays the same create (D29) and recovers the draft's id.

const OWNER = 'user_a';
const NEW = `heisreal:share:${OWNER}:new`;

it('keeps the copy on this device when a create answers 201 without a body', async () => {
  const sent: { body: unknown; key?: string }[] = [];
  let answer: unknown;
  const api: ApiUser = {
    get: jest.fn(),
    command: jest.fn(async (_path, o) => {
      sent.push({ body: o.body, key: o.idempotencyKey });
      return {
        status: 201,
        data: answer,
        etag: null,
        location: null,
      } as ApiUserResponse<never>;
    }),
  };
  const { result } = renderHook(() => useDraft(shareApi(api), OWNER));
  act(() => result.current.update({ title: 'Found', body: 'He is real.' }));

  answer = undefined; // the empty 201
  let ok = true;
  await act(async () => {
    ok = await result.current.flush();
  });
  expect(ok).toBe(false);
  expect(result.current.status).toBe('offline');
  expect(result.current.draftId).toBeNull();
  const kept = JSON.parse(window.sessionStorage.getItem(NEW) ?? 'null');
  expect(kept).toMatchObject({
    createKey: sent[0].key,
    createSent: { title: 'Found', body: 'He is real.' },
  });

  // Typed meanwhile; the retry sends the same key and body, then the new text as a patch.
  act(() => result.current.update({ body: 'He is real, today.' }));
  answer = { id: 'story_1', version: 1 };
  await act(async () => {
    await result.current.flush();
  });
  expect(sent[1]).toEqual(sent[0]);
  expect(result.current.draftId).toBe('story_1');
  expect(window.sessionStorage.getItem(NEW)).toBeNull();
});
