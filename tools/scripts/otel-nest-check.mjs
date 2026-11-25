#!/usr/bin/env node
// The reminder Joel asked for with LG-15 (25 Nov 2026: "make a note to revert workarounds when a
// version is released that is compatible with NestJS 12"). Our request spans are made by hand
// (libs/http wide-events.ts, libs/logging tracing.ts) only because
// @opentelemetry/instrumentation-nestjs-core supports @nestjs/core < 12. This looks at the latest
// release's `supportedVersions` and fails once it includes 12: then switch to it (if Express
// spans no longer need the ESM loader hook) and delete the hand-made request span.
//
// Run weekly by tofu-drift.yml (job otel-nestjs); by hand: node tools/scripts/otel-nest-check.mjs
// Exit 0: not yet (or a range it can't read: a warning to check by hand). Exit 1: time to switch.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE = '@opentelemetry/instrumentation-nestjs-core';

const version = (text) => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(text.trim());
  if (!m) return undefined;
  return [m[1], m[2], m[3]].map((p) =>
    p === undefined || p === 'x' || p === '*' ? 0 : Number(p),
  );
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether `target` (`12.0.0`) satisfies one npm range made of `||` alternatives of space-separated
 * `>=`, `>`, `<=`, `<`, `=` comparators (what instrumentations use). undefined if it can't tell.
 */
export function satisfies(range, target) {
  const want = version(target);
  let readable = true;
  const ok = range.split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return true;
    return parts.every((part) => {
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
      const v = m && version(m[2]);
      if (!v || /[\^~]/.test(part)) {
        readable = false;
        return false;
      }
      const c = compare(want, v);
      switch (m[1] ?? '=') {
        case '>=':
          return c >= 0;
        case '>':
          return c > 0;
        case '<=':
          return c <= 0;
        case '<':
          return c < 0;
        default:
          return c === 0;
      }
    });
  });
  return ok ? true : readable ? false : undefined;
}

/** The `supportedVersions` ranges in the package's built instrumentation file. */
export function supportedRanges(source) {
  const m = /supportedVersions\s*=\s*\[([^\]]*)\]/.exec(source);
  return m ? [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((r) => r[1]) : [];
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'otel-nest-'));
  try {
    const tarball = execFileSync(
      'npm',
      ['pack', `${PACKAGE}@latest`, '--silent', '--pack-destination', dir],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .at(-1);
    execFileSync('tar', ['-xzf', join(dir, tarball), '-C', dir]);
    const latest = JSON.parse(
      readFileSync(join(dir, 'package/package.json'), 'utf8'),
    ).version;
    let source = '';
    for (const file of [
      'dist/instrumentation.cjs',
      'build/src/instrumentation.js',
    ]) {
      try {
        source = readFileSync(join(dir, 'package', file), 'utf8');
        break;
      } catch {
        // older or newer layout
      }
    }
    const ranges = supportedRanges(source);
    const verdicts = ranges.map((r) => satisfies(r, '12.0.0'));
    console.log(
      `${PACKAGE}@${latest} supports @nestjs/core ${ranges.join(' || ') || '(not found)'}`,
    );
    if (verdicts.includes(true)) {
      console.log(
        '::error::It now supports NestJS 12: switch to it and delete the hand-made request span (libs/logging README, "Tracing").',
      );
      process.exitCode = 1;
    } else if (!ranges.length || verdicts.includes(undefined)) {
      console.log(
        '::warning::Could not read its supported range; check it by hand.',
      );
    } else {
      console.log('Not yet: keep the hand-made request span.');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
