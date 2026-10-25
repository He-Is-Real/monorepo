// tools/scripts/tf-roots.sh: which roots a PR touches (tofu-plan.yml only; tofu-apply.yml plans
// every root on every run). Each case commits files to a throwaway git repo and diffs it.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tf-roots.sh', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'tf-roots-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

let n = 0;
// A repo with one base commit, then one commit touching `files`; returns the roots printed.
const changed = (...files) => {
  const repo = join(tmp, `r${n++}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  for (const file of files) {
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), 'x\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  const head = git(repo, 'rev-parse', 'HEAD');
  const result = spawnSync(script, ['changed', base, head], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const tf = 'infra/terraform';

test('a gcp module change selects gcp and cluster', () => {
  assert.equal(changed(`${tf}/modules/gcp/x.tf`), 'gcp\ncluster');
});

test('a gcp root change selects gcp and cluster', () => {
  assert.equal(
    changed(`${tf}/live/dev/gcp/images.auto.tfvars`),
    'gcp\ncluster',
  );
});

test('the Clerk key selects gcp and cluster (both roots pin it)', () => {
  assert.equal(
    changed(`${tf}/live/dev/cluster/clerk.auto.tfvars`),
    'gcp\ncluster',
  );
});

test('a DPA version selects cluster', () => {
  assert.equal(changed('libs/legal/dpa/v2.md'), 'cluster');
});

test('the database schema selects cluster', () => {
  assert.equal(changed('libs/database/schema/001.surql'), 'cluster');
});

test('cluster modules and manifests select cluster', () => {
  for (const file of [
    `${tf}/modules/cluster/main.tf`,
    `${tf}/modules/db-migration/main.tf`,
    `${tf}/modules/db-identity/main.tf`,
    'infra/k8s/surrealdb/base/kustomization.yaml',
    `${tf}/live/dev/cluster/main.tf`,
  ]) {
    assert.equal(changed(file), 'cluster', file);
  }
});

test('the bunny guard selects bunny', () => {
  assert.equal(changed(`${tf}/modules/bunny-state-guard/main.tf`), 'bunny');
  assert.equal(changed(`${tf}/modules/bunny/main.tf`), 'bunny');
  assert.equal(changed(`${tf}/live/dev/bunny/main.tf`), 'bunny');
});

test('bootstrap is listed last', () => {
  assert.equal(changed(`${tf}/modules/bootstrap/kms.tf`), 'bootstrap');
  assert.equal(changed(`${tf}/modules/org/main.tf`), 'bootstrap');
  assert.equal(
    changed(`${tf}/live/dev/bootstrap/main.tf`, `${tf}/modules/gcp/x.tf`),
    'gcp\ncluster\nbootstrap',
  );
});

test('the tofu tooling selects gcp, cluster and bunny', () => {
  for (const file of [
    'tools/scripts/tf.sh',
    'tools/scripts/tf-stage.sh',
    '.github/actions/tofu/action.yml',
    '.github/workflows/tofu-apply.yml',
    'mise.toml',
  ]) {
    assert.equal(changed(file), 'gcp\ncluster\nbunny', file);
  }
});

test('images', () => {
  assert.equal(changed(`${tf}/live/dev/images/main.tf`), 'images');
  assert.equal(changed('tools/scripts/image-tag.sh'), 'images');
});

test('app code selects nothing', () => {
  assert.equal(changed('apps/web/x.ts'), '');
});

test('gcp and bunny together, in order', () => {
  assert.equal(
    changed(`${tf}/live/dev/bunny/main.tf`, `${tf}/modules/gcp/x.tf`),
    'gcp\ncluster\nbunny',
  );
});

test('every root, in order', () => {
  assert.equal(
    changed(
      `${tf}/modules/bootstrap/a.tf`,
      `${tf}/modules/bunny/a.tf`,
      `${tf}/modules/cluster/a.tf`,
      `${tf}/live/dev/images/a.tf`,
      `${tf}/modules/gcp/a.tf`,
    ),
    'gcp\nimages\ncluster\nbunny\nbootstrap',
  );
});

test('a bad subcommand exits 64', () => {
  const result = spawnSync(script, ['nope', 'a', 'b'], { encoding: 'utf8' });
  assert.equal(result.status, 64);
});

test('missing arguments exit 64', () => {
  const result = spawnSync(script, ['changed', 'a'], { encoding: 'utf8' });
  assert.equal(result.status, 64);
});
