#!/usr/bin/env node
/**
 * The Clerk dev instance's settings as code (task 0.5, D2). There's no maintained Clerk
 * OpenTofu (or OpenTofu) provider, so this is the reviewed exception to "all cloud changes through
 * OpenTofu" (docs/delivery-status.md, decision 17): `dev.json` is a partial config, applied
 * with the Clerk CLI's `config patch`, which only touches the keys it lists.
 *
 *   node infra/clerk/clerk-config.mjs            # check (read-only): exit 1 if the instance drifted
 *   node infra/clerk/clerk-config.mjs --apply    # show the request, patch, then check again
 *
 * Needs the Clerk CLI logged in and linked (decision 13). It never reads or prints keys, and
 * prints only the settings `dev.json` manages.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const APP_ID = 'app_3JuNErrA1fDnJI7SBa3Qx9iYkqU'; // "He Is Real" (decision 13)
const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, 'dev.json');
const wanted = JSON.parse(readFileSync(file, 'utf8'));
const { values: args } = parseArgs({ options: { apply: { type: 'boolean' } } });

const clerk = (...argv) =>
  execFileSync('clerk', [...argv, '--app', APP_ID, '--instance', 'dev'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CLERK_MODE: 'agent' },
  });

/** Every leaf in `want` that `have` doesn't match, as `path: have → want`. */
function drift(want, have, path = '') {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    return Object.entries(want).flatMap(([k, v]) =>
      drift(v, have?.[k], path ? `${path}.${k}` : k),
    );
  }
  return JSON.stringify(want) === JSON.stringify(have)
    ? []
    : [`${path}: ${JSON.stringify(have)} -> ${JSON.stringify(want)}`];
}

function check() {
  const live = JSON.parse(
    clerk('config', 'pull', '--keys', ...Object.keys(wanted)),
  );
  return drift(wanted, live);
}

const before = check();
if (!args.apply) {
  if (before.length) {
    console.log(
      `The dev instance differs from ${file}:\n  ${before.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(`The dev instance matches ${file}.`);
  process.exit(0);
}

if (!before.length) {
  console.log('Nothing to change.');
  process.exit(0);
}
console.log(`Changing:\n  ${before.join('\n  ')}\n`);
clerk('config', 'patch', '--file', file, '--dry-run');
clerk('config', 'patch', '--file', file, '--yes');
const after = check();
if (after.length) {
  console.error(`Still different after the patch:\n  ${after.join('\n  ')}`);
  process.exit(1);
}
console.log('Applied; the dev instance now matches.');
