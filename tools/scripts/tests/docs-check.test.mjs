// tools/scripts/docs-check.mjs (`pnpm docs:check`): the shape of the rule files under docs/, their
// ids and tags, the decision register, sizes and banned words. The good fixture passes; each case
// below breaks one check in a copy of it and expects that check's message.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../docs-check.mjs', import.meta.url));
const good = fileURLToPath(
  new URL('./fixtures/docs-check/good', import.meta.url),
);
const repo = fileURLToPath(new URL('../../..', import.meta.url));

const run = (root, args = []) =>
  spawnSync(process.execPath, [script, '--root', root, ...args], {
    encoding: 'utf8',
  });

// A copy of the good fixture, changed by `edit(root)`, checked, then removed.
const check = (edit, args) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-'));
  try {
    cpSync(good, root, { recursive: true });
    edit(root);
    return run(root, args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const replace = (file, from, to) => (root) => {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(from), `${file} has no "${from}"`);
  writeFileSync(path, text.replace(from, to));
};
const BROWSE = 'docs/product/behaviour/browse.md';
const RULE1 =
  '- **REQ-BRW-001** A story card shows a "NEW" badge for 7 days after the story is published. [AB-1]';

test('the good fixture passes', () => {
  const r = run(good);
  assert.equal(r.status, 0, r.stderr);
});

test('the repository itself passes', () => {
  const r = run(repo);
  assert.equal(r.status, 0, r.stderr);
});

const failures = [
  [
    'a rule line without a tag',
    replace(BROWSE, 'published. [AB-1]', 'published.'),
    'rule line must be',
  ],
  [
    'a malformed id',
    replace(BROWSE, '**REQ-BRW-001**', '**REQ-BROWSE-1**'),
    'rule line must be',
  ],
  [
    'a rule over 50 words',
    replace(
      BROWSE,
      'published. [AB-1]',
      `published ${'and then very much more '.repeat(10)}today. [AB-1]`,
    ),
    'REQ-BRW-001: 66 words, limit 50; split it',
  ],
  [
    'a rule of three sentences',
    replace(
      BROWSE,
      'published. [AB-1]',
      'published. It is red. It is round. [AB-1]',
    ),
    'REQ-BRW-001: 3 sentences, limit 2; split it',
  ],
  [
    'a rule broken over two lines',
    replace(
      BROWSE,
      'after the story is published.',
      'after the story\n  is published.',
    ),
    'on one line, id REQ-<AREA>-<NNN>',
  ],
  [
    'an extra line under a rule',
    replace(BROWSE, '  Why: people', '  and more text\n  Why: people'),
    'REQ-BRW-001: a rule is one physical line',
  ],
  [
    'a long Why:',
    replace(
      BROWSE,
      'Why: people come back to see what is new.',
      `Why: ${'people come back '.repeat(9)}to see.`,
    ),
    'REQ-BRW-001: Why: is 29 words, limit 25',
  ],
  [
    'a duplicate id',
    replace(BROWSE, '**REQ-BRW-002**', '**REQ-BRW-001**'),
    'duplicate id REQ-BRW-001',
  ],
  [
    'an id at or above Next id',
    replace(BROWSE, 'Next id: REQ-BRW-003', 'Next id: REQ-BRW-002'),
    'REQ-BRW-002 is at or above "Next id: REQ-BRW-002"',
  ],
  [
    'a rule file without Next id',
    replace('docs/system/logging.md', 'Next id: REQ-LOG-001', ''),
    'no "Next id:" line in the first 10 lines',
  ],
  [
    'a tag with no register row',
    replace(BROWSE, 'published. [AB-1]', 'published. [AB-9]'),
    'REQ-BRW-001: tag [AB-9] has no row in docs/decisions/register.md',
  ],
  [
    'a register "Now at" naming a missing id',
    replace('docs/decisions/register.md', '| WORK-001 ', '| WORK-009 '),
    'AB-2: "Now at" names WORK-009, which no rule file has',
  ],
  [
    'a register "Now at" naming a missing file',
    replace(
      'docs/decisions/register.md',
      'docs/product/principles.md',
      'docs/product/gone.md',
    ),
    'J-2026-01-01: "Now at" names docs/product/gone.md, which does not exist',
  ],
  [
    'a register row with an unknown status',
    replace('docs/decisions/register.md', '| withdrawn |', '| dropped   |'),
    'AB-3: status "dropped" is not one of',
  ],
  [
    'a duplicate register id',
    replace('docs/decisions/register.md', '| AB-3 ', '| AB-2 '),
    'duplicate register id AB-2',
  ],
  [
    'a principle without Applies:',
    replace(
      'docs/product/principles.md',
      'Applies: home, browse, admin tools and mockups.\n',
      '',
    ),
    'PRIN-01: no Applies: line',
  ],
  [
    'a principle without a final tag',
    replace('docs/product/principles.md', '[J-2026-01-01]', ''),
    'PRIN-01: the last line must be the tag',
  ],
  [
    'a principle position over 40 words',
    replace(
      'docs/product/principles.md',
      'Never feature',
      `${'and so on '.repeat(14)}never feature`,
    ),
    'PRIN-01: position is 53 words, limit 40',
  ],
  [
    'a section over 60 lines',
    (root) =>
      appendFileSync(
        join(root, 'docs/system/logging.md'),
        `\n## Long\n\n${'Text.\n'.repeat(60)}`,
      ),
    'section "Long" is 62 lines, limit 60; split it',
  ],
  [
    'a rule file over 300 lines',
    (root) =>
      appendFileSync(
        join(root, 'docs/system/logging.md'),
        Array.from(
          { length: 6 },
          (_, i) => `\n## S${i}\n${'Text.\n'.repeat(50)}`,
        ).join(''),
      ),
    'lines, limit 300; split the file',
  ],
  [
    'a long file without a contents list',
    (root) =>
      appendFileSync(
        join(root, 'docs/system/logging.md'),
        Array.from(
          { length: 3 },
          (_, i) => `\n## S${i}\n${'Text.\n'.repeat(40)}`,
        ).join(''),
      ),
    'add a contents list near the top',
  ],
  [
    'a date in a rule',
    replace(BROWSE, 'published. [AB-1]', 'published on 2026-11-04. [AB-1]'),
    'banned "2026-11-04"',
  ],
  [
    'a written date in a rule',
    replace(BROWSE, 'published. [AB-1]', 'published since 4 Nov 2026. [AB-1]'),
    'banned "4 Nov 2026"',
  ],
  [
    'a name in a rule',
    replace(BROWSE, 'A story card', 'Joel says a story card'),
    'banned "Joel"',
  ],
  [
    'a pull request number',
    replace(BROWSE, 'published. [AB-1]', 'published (#123). [AB-1]'),
    'banned "#123"',
  ],
  [
    'a history word',
    replace(
      BROWSE,
      'A story card shows',
      'A story card no longer hides and shows',
    ),
    'banned "no longer"',
  ],
  [
    'a soft word',
    replace(BROWSE, 'A story card shows', 'A story card should show'),
    'banned "should"',
  ],
  [
    'a history word in a glossary sentence (not its Not: part)',
    replace(
      'docs/product/glossary.md',
      'a staff member who',
      'a staff member who previously',
    ),
    'banned "previously"',
  ],
  [
    'a link to a decision doc in a reference file',
    (root) =>
      writeFileSync(
        join(root, 'docs/process/notes.md'),
        '# Notes\n\nSee [the doc](../../context/research/logging.html).\n',
      ),
    'links to a decision doc',
  ],
];

for (const [name, edit, message] of failures) {
  test(`fails on ${name}`, () => {
    const r = check(edit);
    assert.equal(r.status, 1, `expected failure; stdout: ${r.stdout}`);
    assert.ok(
      r.stderr.includes(message),
      `expected "${message}" in:\n${r.stderr}`,
    );
  });
}

test('quotes and code are exempt from banned words', () => {
  const r = check(
    replace(
      BROWSE,
      'published. [AB-1]',
      'published; it reads "should we?" and `TBD`. [AB-1]',
    ),
  );
  assert.equal(r.status, 0, r.stderr);
});

test('the root AGENTS.md limit only warns for now', () => {
  const r = check((root) =>
    appendFileSync(join(root, 'AGENTS.md'), 'Line.\n'.repeat(160)),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /AGENTS\.md: 16\d lines, limit 150/);
});

// --base: the rules a branch changes, compared with its merge base.
const git = (root, ...args) => {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.email=docs-check@example.com',
      '-c',
      'user.name=docs-check',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
};
const withBranch = (edit) =>
  check(
    (root) => {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'base');
      git(root, 'checkout', '-qb', 'change');
      edit(root);
      git(root, 'commit', '-qam', 'change');
    },
    ['--base', 'main'],
  );

test('--base: a wording fix that keeps its tag passes', () => {
  const r = withBranch(
    replace(BROWSE, RULE1, RULE1.replace('A story card', 'Each story card')),
  );
  assert.equal(r.status, 0, r.stderr);
});

test('--base: a changed rule citing a withdrawn decision fails', () => {
  const r = withBranch(
    replace(
      BROWSE,
      RULE1,
      RULE1.replace('7 days', '8 days').replace('[AB-1]', '[AB-3]'),
    ),
  );
  assert.equal(r.status, 1, r.stdout);
  assert.ok(
    r.stderr.includes('REQ-BRW-001 changed: its tag [AB-3] is withdrawn'),
    r.stderr,
  );
});

test('--base: a new tag needs its register row in the same change', () => {
  const r = withBranch(
    replace(BROWSE, RULE1, RULE1.replace('[AB-1]', '[AB-7]')),
  );
  assert.equal(r.status, 1, r.stdout);
  assert.ok(
    r.stderr.includes(
      'REQ-BRW-001 changed: its tag [AB-7] has no register row',
    ),
    r.stderr,
  );
});
