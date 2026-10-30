import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ConsentAsk, ConsentFormView } from './consent-form';

// A consent is one person's (GDPR Art 9). Person A opens the form; before A's save finishes,
// person B becomes the signed-in one on this browser (signing in in another tab). Nothing may
// be recorded for B from A's ticks, and A's ticks must not carry over into B's form. The e2e
// fixtures have one fixed person, so the switch is staged here around the real form and the
// real api-user client, with fetch standing in for api-user.

const router = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/consent/signup',
}));
jest.mock('@clerk/react', () => ({}));

const tokenFor = (sub: string) =>
  `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.s`;

/** Who Clerk would hand a token for now. */
let signedIn = 'user_a';
const getToken = async () => tokenFor(signedIn);

interface Sent {
  token: string | undefined;
  statement: string;
  key: string | null;
}
let sent: Sent[];
/** Each request waits for its own answer, so a test can act mid-save. */
let answers: (() => void)[];

beforeEach(() => {
  signedIn = 'user_a';
  sent = [];
  answers = [];
  router.replace.mockReset();
  global.fetch = jest.fn((_url: string, init: RequestInit) => {
    const headers = init.headers as Headers;
    sent.push({
      token: headers.get('Authorization')?.replace('Bearer ', ''),
      statement: JSON.parse(String(init.body)).statement,
      key: headers.get('Idempotency-Key'),
    });
    return new Promise((resolve) =>
      answers.push(() =>
        resolve({
          ok: true,
          status: 201,
          text: async () => '{}',
          headers: new Headers(),
        } as unknown as Response),
      ),
    );
  }) as unknown as typeof fetch;
});

const ask: ConsentAsk = {
  form: 'signup',
  formVersion: 'v1',
  boxes: [
    { statement: 'age_18plus', label: 'I’m 18 or over' },
    { statement: 'account_data', label: 'Keep my account details' },
  ],
  mechanism: 'web_form_submission',
  blocks: [],
  privacy: { version: 'dpa1', blocks: [], pdf: null },
  terms: null,
  returnTo: '/stories',
  apiUserUrl: 'https://api-user.example',
};

const view = (userId: string) => (
  <ConsentFormView
    {...ask}
    signedIn
    userId={userId}
    getToken={getToken}
    signOut={(button) => button}
  />
);

const boxes = () => screen.getAllByRole<HTMLInputElement>('checkbox');
const tickAllAndAccept = () => {
  for (const box of boxes()) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
};
/** Lets the save loop take its next step. */
const settle = () => act(() => Promise.resolve());

it('records every box for the person who ticked them, then goes on', async () => {
  render(view('user_a'));
  tickAllAndAccept();
  await waitFor(() => expect(sent).toHaveLength(1));
  await act(async () => answers[0]());
  await waitFor(() => expect(sent).toHaveLength(2));
  await act(async () => answers[1]());

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/stories'));
  expect(sent.map((s) => [s.token, s.statement])).toEqual([
    [tokenFor('user_a'), 'age_18plus'],
    [tokenFor('user_a'), 'account_data'],
  ]);
});

it('records nothing for someone who signs in mid-save, and starts their form afresh', async () => {
  const { rerender } = render(view('user_a'));
  tickAllAndAccept();
  await waitFor(() => expect(sent).toHaveLength(1));

  // B signs in elsewhere; Clerk now answers for B, then the page hears of it.
  signedIn = 'user_b';
  rerender(view('user_b'));
  await act(async () => answers[0]());
  await settle();

  // Only A's first box, sent with A's token before the switch; nothing more, nothing for B.
  expect(sent.map((s) => s.token)).toEqual([tokenFor('user_a')]);
  expect(router.replace).not.toHaveBeenCalled();
  expect(boxes().every((b) => !b.checked)).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain(
    'saved nothing to the account signed in now',
  );

  // B's own answer is B's, under new keys.
  tickAllAndAccept();
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1].token).toBe(tokenFor('user_b'));
  expect(sent[1].key).not.toBe(sent[0].key);
});

it('sends nothing with the new person’s token before the page hears of the switch', async () => {
  render(view('user_a'));
  tickAllAndAccept();
  await waitFor(() => expect(sent).toHaveLength(1));

  // Clerk already answers for B, but the page still shows A's form.
  signedIn = 'user_b';
  await act(async () => answers[0]());
  await settle();

  expect(sent.map((s) => s.token)).toEqual([tokenFor('user_a')]);
  expect(router.replace).not.toHaveBeenCalled();
  expect(boxes().every((b) => !b.checked)).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain(
    'saved nothing to the account signed in now',
  );
});

it('doesn’t go on as the new person when the switch comes during the last save', async () => {
  render(view('user_a'));
  tickAllAndAccept();
  await waitFor(() => expect(sent).toHaveLength(1));
  await act(async () => answers[0]());
  await waitFor(() => expect(sent).toHaveLength(2));

  // A's last box is on its way with A's token; B signs in before the answer comes back.
  signedIn = 'user_b';
  await act(async () => answers[1]());
  await settle();

  expect(sent.map((s) => s.token)).toEqual([
    tokenFor('user_a'),
    tokenFor('user_a'),
  ]);
  expect(router.replace).not.toHaveBeenCalled();
  expect(boxes().every((b) => !b.checked)).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain(
    'saved nothing to the account signed in now',
  );
});
