// tools/scripts/otel-nest-check.mjs: the weekly reminder to drop the hand-made request span.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { satisfies, supportedRanges } from '../otel-nest-check.mjs';

test('reads the supported range from the built instrumentation', () => {
  assert.deepEqual(
    supportedRanges('const supportedVersions = [">=4.0.0 <12"];'),
    ['>=4.0.0 <12'],
  );
  assert.deepEqual(supportedRanges('nothing here'), []);
});

test('says whether NestJS 12 is in it', () => {
  assert.equal(satisfies('>=4.0.0 <12', '12.0.0'), false);
  assert.equal(satisfies('>=4.0.0 <13', '12.0.0'), true);
  assert.equal(satisfies('>=4.0.0 <12 || >=12.1.0 <14', '12.0.0'), false);
  assert.equal(satisfies('>=4.0.0', '12.0.0'), true);
  assert.equal(satisfies('^11.0.0', '12.0.0'), undefined);
});
