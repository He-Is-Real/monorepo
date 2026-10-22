// tools/scripts/tf-stage.sh: the stage decision tofu-apply.yml records after each root. Failed,
// rejected, stale or superseded stops every later stage; "not selected" and "no changes" stop
// nothing.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tf-stage.sh', import.meta.url));

// stage(prev, selected, plan_result, changes, go, apply_result)
const stage = (...args) => {
  const result = spawnSync(script, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};

test('not selected → ok', () => {
  assert.equal(stage('ok', 'false', '', '', '', ''), 'ok');
});

test('plan failure → blocked: plan failure', () => {
  assert.equal(
    stage('ok', 'true', 'failure', '', '', ''),
    'blocked: plan failure',
  );
});

test('plan skipped while selected → blocked', () => {
  assert.equal(
    stage('ok', 'true', 'skipped', '', '', ''),
    'blocked: plan skipped',
  );
});

test('plan cancelled or empty while selected → blocked', () => {
  assert.equal(
    stage('ok', 'true', 'cancelled', '', '', ''),
    'blocked: plan cancelled',
  );
  assert.match(stage('ok', 'true', '', '', '', ''), /^blocked: plan/);
});

test('plan success, no changes → ok', () => {
  assert.equal(stage('ok', 'true', 'success', 'false', '', ''), 'ok');
});

test('changes, go false (superseded) → blocked: superseded or rejected', () => {
  assert.equal(
    stage('ok', 'true', 'success', 'true', 'false', 'skipped'),
    'blocked: superseded or rejected',
  );
});

test('changes, go empty (rejected) → blocked: superseded or rejected', () => {
  assert.equal(
    stage('ok', 'true', 'success', 'true', '', 'skipped'),
    'blocked: superseded or rejected',
  );
});

test('changes, go true, apply success → ok', () => {
  assert.equal(stage('ok', 'true', 'success', 'true', 'true', 'success'), 'ok');
});

test('changes, go true, apply failure (failed or stale) → blocked', () => {
  assert.equal(
    stage('ok', 'true', 'success', 'true', 'true', 'failure'),
    'blocked: apply failure',
  );
});

test('changes, go true, apply cancelled or skipped → blocked', () => {
  assert.equal(
    stage('ok', 'true', 'success', 'true', 'true', 'cancelled'),
    'blocked: apply cancelled',
  );
  assert.equal(
    stage('ok', 'true', 'success', 'true', 'true', 'skipped'),
    'blocked: apply skipped',
  );
  assert.match(stage('ok', 'true', 'success', 'true', 'true', ''), /^blocked/);
});

test('changes is anything but true or false → blocked', () => {
  assert.match(stage('ok', 'true', 'success', '', '', ''), /^blocked/);
});

test('prev blocked → blocked: upstream, even if not selected', () => {
  assert.equal(
    stage('blocked: plan failure', 'false', '', '', '', ''),
    'blocked: upstream',
  );
  assert.equal(
    stage('blocked: wave 1', 'true', 'success', 'false', '', ''),
    'blocked: upstream',
  );
  assert.equal(
    stage('', 'true', 'success', 'false', '', ''),
    'blocked: upstream',
  );
});

test('wrong argument count → exit 64', () => {
  const result = spawnSync(script, ['ok', 'true'], { encoding: 'utf8' });
  assert.equal(result.status, 64);
});
