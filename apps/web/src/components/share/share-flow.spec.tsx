import React, { createRef } from 'react';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { ApiUserProblem } from '@/lib/api-user';
import { renderLegalMarkdown } from '@/lib/markdown';
import type { ShareForm, ShareLegal } from '@/lib/share-legal';
import { EMPTY_FIELDS, type SubmissionLimits } from './share-api';
import { ConsentStep, Limits, ReviewStep } from './share-flow';

// Codex #118, 1 (D114): the consent boxes are the form version's structured data, drawn by the
// page outside the document's words, and a step whose required box the version doesn't have
// asks nothing and goes no further. The stub api-public-read serves only dev's forms, which have
// every box, so a version missing one is staged here, one step rendered on its own.

const form = (boxes: ShareForm['boxes']): ShareForm => ({
  version: 'v1',
  boxes,
  // The words even mention the statement as a list item: never turned into a box.
  html: renderLegalMarkdown(
    '# Your story\n\n- `special_category_religious`\n',
    {
      topLevel: 3,
    },
  ),
  privacyVersion: 'dev_placeholder',
  privacyHtml: renderLegalMarkdown('Privacy words'),
});
const ART9 = {
  statement: 'special_category_religious' as const,
  label: 'Store my story',
};
const PUBLISH = { statement: 'publish' as const, label: 'Publish my story' };
const LIMITS: SubmissionLimits = {
  storyText: { min: 200, max: 10000 },
  tags: { min: 1, max: 5 },
  openDrafts: { max: 3, open: 1 },
  submissions: { per7Days: 1, nextAvailableAt: null },
};

describe('ConsentStep', () => {
  it('draws the Art 9 box from the version’s boxes, outside the form’s words', () => {
    const legal: ShareLegal = {
      testimony: form([ART9, PUBLISH]),
      social: null,
    };
    render(
      <ConsentStep
        heading={createRef()}
        legal={legal}
        grant={jest.fn()}
        onBack={jest.fn()}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Store my story' });
    const words = screen.getByRole('region', { name: 'The form' });
    expect(within(words).queryAllByRole('checkbox')).toHaveLength(0);
    expect(words.contains(box)).toBe(false);
    // Only the Art 9 box here: publishing is asked at Review.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('fails closed when the version has no Art 9 box: nothing to tick, nothing recorded', () => {
    const grant = jest.fn();
    const legal: ShareLegal = { testimony: form([PUBLISH]), social: null };
    render(
      <ConsentStep
        heading={createRef()}
        legal={legal}
        grant={grant}
        onBack={jest.fn()}
      />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain(
      'can’t be shown right now',
    );
    expect(screen.queryByRole('button', { name: /I agree/ })).toBeNull();
    expect(grant).not.toHaveBeenCalled();
  });
});

describe('ReviewStep', () => {
  const draft = {
    draftId: 'd1',
    version: 2,
    fields: {
      ...EMPTY_FIELDS,
      title: 'T',
      body: 'x'.repeat(250),
      tagSlugs: ['hope'],
    },
    status: 'saved' as const,
    error: null,
    conflict: null,
    update: jest.fn(),
    flush: jest.fn(async () => true),
    load: jest.fn(),
    resolve: jest.fn(),
    forget: jest.fn(),
    setVersion: jest.fn(),
    beginSubmit: jest.fn(),
    settleSubmit: jest.fn(),
    current: () => ({ draftId: 'd1', version: 2 }),
  };
  const consents = {
    current: [{ type: 'special_category_religious', counts: true }],
    signup: { accepted: true },
    testimony: {
      version: 'v1',
      latestVersion: 'v1',
      updateAvailable: false,
      acceptanceRequired: false,
    },
  };

  it('fails closed when publishing is needed and the version has no publish box', () => {
    const calls = { grant: jest.fn(), submit: jest.fn() };
    render(
      <Limits.Provider value={LIMITS}>
        <ReviewStep
          heading={createRef()}
          draft={draft}
          tags={[{ slug: 'hope', name: 'Hope', category: 'emotion' }]}
          legal={{ testimony: form([ART9]), social: null }}
          consents={consents}
          calls={calls as never}
          refreshConsents={jest.fn()}
          onEdit={jest.fn()}
          onDone={jest.fn()}
        />
      </Limits.Provider>,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain(
      'publishing consent can’t be shown right now',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(calls.grant).not.toHaveBeenCalled();
    expect(calls.submit).not.toHaveBeenCalled();
  });

  it('a privacy policy published after the person reached Review: the draft is kept, and the way on is a reload, not a retry of the old version', async () => {
    const calls = {
      grant: jest.fn(async () => {
        throw new ApiUserProblem({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'legal_document_not_in_force',
          detail: 'privacyPolicyVersion is not the version in force.',
        });
      }),
      submit: jest.fn(),
    };
    const forget = jest.fn();
    render(
      <Limits.Provider value={LIMITS}>
        <ReviewStep
          heading={createRef()}
          draft={{ ...draft, forget }}
          tags={[{ slug: 'hope', name: 'Hope', category: 'emotion' }]}
          legal={{ testimony: form([ART9, PUBLISH]), social: null }}
          consents={consents}
          calls={calls as never}
          refreshConsents={jest.fn()}
          onEdit={jest.fn()}
          onDone={jest.fn()}
        />
      </Limits.Provider>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Publish my story' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('updated');
    expect(alert.textContent).toContain('Your story is saved');
    expect(alert.textContent).not.toContain('privacyPolicyVersion');
    // No "Submit for review" that would send the old version again: a reload instead.
    expect(
      screen.queryByRole('button', { name: 'Submit for review' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reload the page' }),
    ).toBeTruthy();
    await waitFor(() => expect(calls.grant).toHaveBeenCalledTimes(1));
    expect(calls.submit).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });
});
