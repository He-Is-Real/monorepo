import { foldLabel, redline, type RedlineItem } from './redline';

// The folding and pairing rules behind every redline (plan 4e): hard to see one by one from the
// pages, which the e2e suites check as people see them (consent.e2e.ts, admin-consent.e2e.ts).

/** Each item as one line: "## heading", a paragraph with [-removed-] and {+added+}, or a fold. */
const read = (items: RedlineItem[]) =>
  items.map((i) =>
    i.type === 'fold'
      ? foldLabel(i)
      : `${i.heading ? '## ' : ''}${i.segments
          .map((s) =>
            s.kind === 'added'
              ? `{+${s.text}+}`
              : s.kind === 'removed'
                ? `[-${s.text}-]`
                : s.text,
          )
          .join('')}`,
  );

const V1 = `## Your story

By ticking this box you let He Is Real Today store and publish **this story**, which shows your Christian faith.

## Who sees it

Anyone visiting [heisreal.today](https://heisreal.today), and our moderators before it's published.

## Changing your mind

You can withdraw or delete any story at any time.
`;

describe('redline', () => {
  it('marks changed words under their heading and folds unchanged sections (the 8b mockup)', () => {
    const v4 = V1.replace('**this story**', 'every story you submit').replace(
      'any story at',
      'any story, or delete your account, at',
    );
    expect(read(redline(V1, v4))).toEqual([
      '## Your story',
      'By ticking this box you let He Is Real Today store and publish [-this-]{+every+} story {+you submit+}, which shows your Christian faith.',
      '⋯ 1 unchanged section ⋯',
      '## Changing your mind',
      'You can withdraw or delete any story{+, or delete your account,+} at any time.',
    ]);
  });

  it('is empty when only marks or link addresses changed', () => {
    expect(
      redline(
        V1,
        V1.replace('https://heisreal.today', 'https://www.heisreal.today'),
      ),
    ).toEqual([]);
  });

  it('folds unchanged paragraphs inside a changed section, and shows whole blocks added or removed', () => {
    const before = '## Terms\n\nOne.\n\nTwo.\n\nThree.\n\n## Old\n\nGone.\n';
    const after =
      '## Terms\n\nOne.\n\nTwo.\n\nThree, now longer.\n\n- A new item\n';
    expect(read(redline(before, after))).toEqual([
      '## Terms',
      '⋯ 2 unchanged paragraphs ⋯',
      'Three{+, now longer+}.',
      '{+• A new item+}',
      '## [-Old-]',
      '[-Gone.-]',
    ]);
  });
});
