// .gitleaks.toml: the Bunny.net key rule (GitHub secret scanning doesn't know Bunny keys) on
// top of gitleaks' default rules. Fixtures are written to a temp dir at runtime with made-up
// keys, so the repo never holds anything that looks like a key. Needs gitleaks on PATH
// (`mise install`; CI installs the pinned release).
//
//   node --test tools/scripts/tests/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const config = fileURLToPath(
  new URL('../../../.gitleaks.toml', import.meta.url),
);

const hex = (n) =>
  randomBytes(Math.ceil(n / 2))
    .toString('hex')
    .slice(0, n);
const groups = (...sizes) => sizes.map(hex).join('-');
// Both shapes Bunny uses: UUID-like 8-4-4-4-12, and 41 characters 8-4-4-12-4-4.
const U = groups(8, 4, 4, 4, 12);
const L = groups(8, 4, 4, 12, 4, 4);
const alnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ghp =
  'ghp_' + Array.from(randomBytes(36), (b) => alnum[b % alnum.length]).join('');

// Scans one fixture file; returns gitleaks' exit code and the rule IDs it reported.
const scan = (path, content) => {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-test-'));
  try {
    const file = join(dir, 'src', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    const report = join(dir, 'report.json');
    const result = spawnSync(
      'gitleaks',
      [
        'dir',
        join(dir, 'src'),
        '--config',
        config,
        '--no-banner',
        '--redact',
        '--exit-code',
        '1',
        '--report-format',
        'json',
        '--report-path',
        report,
      ],
      { encoding: 'utf8' },
    );
    assert.ok(
      result.status === 0 || result.status === 1,
      `gitleaks failed: ${result.error ?? result.stderr}`,
    );
    const rules =
      result.status === 1
        ? JSON.parse(readFileSync(report, 'utf8')).map((f) => f.RuleID)
        : [];
    return { status: result.status, rules };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const flagged = [
  ['x.env', (k) => `BUNNY_STREAM_API_KEY=${k}\n`],
  ['a.json', (k) => `{ "AccessKey": "${k}" }\n`],
  [
    'run.sh',
    (k) => `curl -H "AccessKey: ${k}" https://video.bunnycdn.com/library\n`,
  ],
  ['main.tf', (k) => `bunny_password = "${k}"\n`],
  ['a.sh', (k) => `bunny="${k}"\n`],
  ['b.json', (k) => `{ "bunny": "${k}" }\n`],
];

for (const [shape, key] of [
  ['8-4-4-4-12', U],
  ['8-4-4-12-4-4', L],
]) {
  for (const [path, line] of flagged) {
    test(`flags a ${shape} Bunny key in ${path}`, () => {
      const { status, rules } = scan(path, line(key));
      assert.equal(status, 1);
      assert.ok(rules.includes('bunny-key'), `rules: ${rules}`);
    });
  }
}

test('ignores UUIDs without Bunny context', () => {
  assert.equal(scan('a.yaml', `id: ${U}\nother: ${L}\n`).status, 0);
});

// apps/dev-seed/src/app/bunny-media.json records Bunny video ids (public GUIDs, not keys) under
// `videoId`, so the record never trips the rule and nothing needs an allowlist.
test('ignores the dev-seed media record’s video ids', () => {
  const record = `{\n  "libraryId": "123",\n  "clips": {\n    "clip-01": {\n      "videoId": "${U}",\n      "thumbnailPath": "${U}/thumbnail.jpg"\n    }\n  }\n}\n`;
  assert.equal(
    scan('apps/dev-seed/src/app/bunny-media.json', record).status,
    0,
  );
});

test('ignores package-lock integrity lines', () => {
  const integrity = `"integrity": "sha512-${randomBytes(48).toString('base64')}"`;
  assert.equal(scan('package-lock.json', `{ ${integrity} }\n`).status, 0);
});

test('ignores .env.example placeholders', () => {
  assert.equal(
    scan('apps/web/.env.example', `BUNNY_STREAM_API_KEY=${L}\n`).status,
    0,
  );
});

test('default rules still apply', () => {
  const { status, rules } = scan('a.txt', `token: ${ghp}\n`);
  assert.equal(status, 1);
  assert.ok(
    rules.some((r) => r.startsWith('github')),
    `rules: ${rules}`,
  );
});
