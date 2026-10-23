// tools/scripts/image-services.txt is the one list of image services (PR #59 review: a new
// service was built but left out of tofu-apply.yml's archive). It must equal the Nx projects
// with a `container` target, and workflows and the images root must read it rather than list
// services by hand.
//
//   node --test tools/scripts/tests/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p) => readFileSync(join(repo, p), 'utf8');

const listed = read('tools/scripts/image-services.txt')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

test('the list equals the Nx projects with a container target', () => {
  const withContainer = readdirSync(join(repo, 'apps')).filter((app) => {
    const pkg = join(repo, 'apps', app, 'package.json');
    const project = join(repo, 'apps', app, 'project.json');
    const targets = {
      ...(existsSync(pkg)
        ? JSON.parse(readFileSync(pkg, 'utf8')).nx?.targets
        : {}),
      ...(existsSync(project)
        ? JSON.parse(readFileSync(project, 'utf8')).targets
        : {}),
    };
    return 'container' in targets;
  });
  assert.deepEqual([...listed].sort(), withContainer.sort());
});

test('image-services.sh prints the list on one line', () => {
  const out = execFileSync(join(repo, 'tools/scripts/image-services.sh'), {
    encoding: 'utf8',
  });
  assert.equal(out, `${listed.join(' ')}\n`);
});

// A line naming three or more services is a hand-written list.
const handLists = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter(
      (l) =>
        listed.filter((s) => new RegExp(`(^|[^\\w-])${s}([^\\w-]|$)`).test(l))
          .length >= 3,
    );

const files = [
  ...readdirSync(join(repo, '.github/workflows')).map(
    (f) => `.github/workflows/${f}`,
  ),
  'infra/terraform/live/dev/images/main.tf',
];
for (const file of files) {
  test(`${file} lists no services by hand`, () => {
    assert.deepEqual(handLists(read(file)), []);
  });
}

test('tofu-apply.yml archives, and checks after the untar, every service from the list', () => {
  const steps = Object.values(
    parse(read('.github/workflows/tofu-apply.yml')).jobs,
  ).flatMap((job) => (job.steps ?? []).map((s) => s.run ?? ''));
  const archive = steps.filter(
    (r) => r.includes('images-dist.tgz') && r.includes('tar -c'),
  );
  const check = steps.filter((r) => r.includes('image-tag.sh'));
  assert.ok(archive.length > 0 && check.length > 0);
  for (const run of [...archive, ...check]) {
    assert.match(run, /image-services\.sh/);
  }
});
