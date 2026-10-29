import React from 'react';
import { act, render } from '@testing-library/react';
import { addHeartsToAccount } from '@/lib/favourites';
import { usePublishPersonalSession } from '@/lib/personal-session';

// The device prompt's "Add" (Joel's F5) is A's choice for A's account: nothing of it may ever be
// sent as someone else (security review of #117 round 3; Codex round 4). Clerk's getToken()
// answers for whoever is signed in when it resolves, so the person can change mid-way, even
// while a token is being fetched. This can't be staged in the e2e suite (its fixture person is
// fixed), so it runs here against the real hearts store, with api-user and the token held back.

interface Command {
  /** The token's person (`sub`). */
  sub: string;
  path: string;
  method: string;
  answer: () => void;
}
const mockCommands: Command[] = [];

/** A session token shaped like Clerk's: only its payload's `sub` is read in the browser. */
const jwt = (sub: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
const subOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

/** Like Clerk's getToken: the token of whoever is signed in when it resolves. */
let mockSignedIn = 'user_a';
/** While set, getToken waits for it (a token being fetched). */
let mockTokenGate: Promise<void> | null = null;
const getToken = async () => {
  if (mockTokenGate) await mockTokenGate;
  return jwt(mockSignedIn);
};

jest.mock('@/lib/api-user', () => {
  const actual = jest.requireActual('@/lib/api-user');
  const done = { status: 204, data: undefined, etag: null, location: null };
  return {
    ...actual,
    apiUser: (_url: string, token: () => Promise<string | null>) => ({
      get: async () => ({
        status: 200,
        data: { data: [], nextCursor: null },
        etag: null,
        location: null,
      }),
      // As the real client: no token, or a refused one, and nothing is sent.
      command: async (path: string, { method }: { method: string }) => {
        const sent = (await token()) as string;
        // Only the first save is held; any later one answers at once.
        if (mockCommands.length > 0) {
          mockCommands.push({
            sub: subOf(sent),
            path,
            method,
            answer: () => undefined,
          });
          return done;
        }
        return new Promise((resolve) =>
          mockCommands.push({
            sub: subOf(sent),
            path,
            method,
            answer: () => resolve(done),
          }),
        );
      },
    }),
  };
});

/** The header's part: says who is signed in. */
function SignedIn({ userId }: { userId: string }) {
  usePublishPersonalSession(userId, 'https://api-user.test', getToken);
  return null;
}

beforeEach(() => {
  mockCommands.length = 0;
  mockSignedIn = 'user_a';
  mockTokenGate = null;
});

it('Add stops when someone else signs in: nothing goes into their account', async () => {
  const { rerender, unmount } = render(<SignedIn userId="user_a" />);
  let added: Promise<{ added: string[]; failed: string[] }> | undefined;
  await act(async () => {
    added = addHeartsToAccount(['story_one', 'story_two', 'story_three']);
  });
  expect(mockCommands.map((c) => [c.sub, c.path, c.method])).toEqual([
    ['user_a', '/v1/account/favourites/story_one', 'PUT'],
  ]);

  // B signs in in the same tab while A's first save is on its way.
  mockSignedIn = 'user_b';
  rerender(<SignedIn userId="user_b" />);
  await act(async () => mockCommands[0].answer());
  const result = await added;

  expect(mockCommands.map((c) => [c.sub, c.path])).toEqual([
    ['user_a', '/v1/account/favourites/story_one'],
  ]);
  expect(result?.added).toEqual([]);
  unmount();
});

it('a token fetched while someone else signed in is never used: nothing is sent', async () => {
  // Codex, #117 round 4: A presses Add; while A's token is being fetched, B signs in, so the
  // token that arrives is B's.
  const { unmount } = render(<SignedIn userId="user_a" />);
  let release = () => undefined as void;
  mockTokenGate = new Promise<void>((resolve) => (release = resolve));
  let added: Promise<{ added: string[]; failed: string[] }> | undefined;
  await act(async () => {
    added = addHeartsToAccount(['story_one']);
  });
  mockSignedIn = 'user_b';
  await act(async () => release());
  const result = await added;

  expect(mockCommands).toEqual([]);
  expect(result).toEqual({ added: [], failed: ['story_one'] });
  unmount();
});
