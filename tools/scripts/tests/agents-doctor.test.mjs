// tools/scripts/agents-doctor.mjs (`pnpm agents:doctor`): the repo half passes on this repo, and the
// machine half never fails.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../agents-doctor.mjs', import.meta.url));
const run = (args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('--repo: skills, the .claude/skills link and folder CLAUDE.md files are in order', () => {
  const r = run(['--repo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo OK/);
});

test('the machine half reports and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Required plugins missing/);
});

test('--repo: a skill and CLAUDE.md written with CRLF line endings pass', () => {
  // The script finds the repo from its own path, so run a copy inside a small temporary repo.
  const root = mkdtempSync(join(tmpdir(), 'agents-doctor-'));
  try {
    mkdirSync(join(root, 'tools/scripts'), { recursive: true });
    copyFileSync(script, join(root, 'tools/scripts/agents-doctor.mjs'));
    mkdirSync(join(root, '.agents/skills/demo'), { recursive: true });
    writeFileSync(
      join(root, '.agents/skills/demo/SKILL.md'),
      '---\r\nname: demo\r\ndescription: Use when testing.\r\n---\r\n\r\n# Demo\r\n',
    );
    mkdirSync(join(root, '.claude'));
    symlinkSync('../.agents/skills', join(root, '.claude/skills'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app/AGENTS.md'), '# App\r\n');
    writeFileSync(join(root, 'app/CLAUDE.md'), '@AGENTS.md\r\n');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', '-A'], { cwd: root });
    const r = spawnSync(
      process.execPath,
      [join(root, 'tools/scripts/agents-doctor.mjs'), '--repo'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /repo OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
