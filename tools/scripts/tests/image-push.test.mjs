// tools/scripts/image-push.sh: Release Images (and Snapshot images) build the changed services
// side by side (pipeline speed review, P2), skip a tag that already exists, keep each service's
// layer cache scope, and never end green with a missing digest. Run against a stub `docker` whose
// builds each wait until every expected build has started, so the services only finish if they
// really run at once.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

const script = fileURLToPath(new URL('../image-push.sh', import.meta.url));
const tagScript = fileURLToPath(new URL('../image-tag.sh', import.meta.url));
const REPO = 'registry.example/heisreal-dev/apps';

// `docker buildx imagetools inspect <image> [--format …]` and `docker buildx build <dir> …`.
// Existing images are listed one per line in $STUB/existing; builds are logged to $STUB/builds.
const STUB_DOCKER = `#!/usr/bin/env bash
set -u
args=("$@")
case "\${args[1]} \${args[2]:-}" in
  "imagetools inspect")
    image="\${args[3]}"
    grep -qxF "$image" "$STUB/existing" || exit 1
    if [ "\${args[4]:-}" = --format ]; then
      svc="\${image##*/}"; svc="\${svc%%:*}"
      if grep -qxF "$svc" "$STUB/nodigest"; then echo '{}'; else
        printf '{"digest":"sha256:%s"}\\n' "$(printf %s "$image" | sha256sum | cut -c1-64)"
      fi
    fi
    ;;
  "build "*)
    dir="\${args[2]}"; svc="$(basename "$(dirname "$dir")")"
    image=""
    for ((i = 0; i < \${#args[@]}; i++)); do
      [ "\${args[i]}" = --tag ] && image="\${args[i+1]}"
    done
    echo "$svc \${args[*]:3}" >> "$STUB/builds"
    touch "$STUB/started-$svc"
    # Wait for every expected build to start: a one-at-a-time loop never gets past this.
    for _ in $(seq 100); do
      [ "$(ls "$STUB" | grep -c '^started-')" -ge "$EXPECT" ] && break
      sleep 0.1
    done
    [ "$(ls "$STUB" | grep -c '^started-')" -ge "$EXPECT" ] || { echo "builds ran one at a time" >&2; exit 3; }
    grep -qxF "$svc" "$STUB/fail" && { echo "boom: $svc" >&2; exit 1; }
    echo "$image" >> "$STUB/existing"
    ;;
  *) exit 2 ;;
esac
`;

/**
 * Runs image-push.sh for `services` in a scratch checkout. `existing`: services whose current tag
 * is already in the registry; `fail`: builds that fail; `nodigest`: images whose inspect has no
 * digest; `expect`: how many builds must be running at once before any finishes.
 */
function push(
  services,
  { existing = [], fail = [], nodigest = [], expect } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'image-push-'));
  try {
    const stub = join(dir, 'stub');
    const bin = join(dir, 'bin');
    mkdirSync(stub);
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), STUB_DOCKER);
    chmodSync(join(bin, 'docker'), 0o755);
    const tags = {};
    for (const svc of services) {
      mkdirSync(join(dir, 'apps', svc, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'apps', svc, 'dist', 'main.js'), `// ${svc}\n`);
      tags[svc] = spawnSync(tagScript, [svc], {
        cwd: dir,
        encoding: 'utf8',
      }).stdout.trim();
    }
    writeFileSync(
      join(stub, 'existing'),
      existing.map((svc) => `${REPO}/${svc}:${tags[svc]}\n`).join(''),
    );
    writeFileSync(join(stub, 'fail'), fail.map((s) => `${s}\n`).join(''));
    writeFileSync(
      join(stub, 'nodigest'),
      nodigest.map((s) => `${s}\n`).join(''),
    );
    writeFileSync(join(stub, 'builds'), '');
    const result = spawnSync(script, services, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        STUB: stub,
        EXPECT: String(expect ?? services.length - existing.length),
        REPO,
        GITHUB_SHA: 'f'.repeat(40),
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'o/r',
      },
    });
    const builds = readFileSync(join(stub, 'builds'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    return {
      status: result.status,
      rows: result.stdout.trim().split('\n'),
      err: result.stderr,
      builds,
      tags,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('builds the missing images at once and skips tags that exist, rows in the given order', () => {
  const r = push(['api-user', 'web', 'dev-seed'], { existing: ['web'] });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.builds.map((b) => b.split(' ')[0]).sort(), [
    'api-user',
    'dev-seed',
  ]);
  assert.deepEqual(
    r.rows.map((row) =>
      row.split(' | ').map((c) => c.replace(/[|`]/g, '').trim()),
    ),
    [
      [
        'api-user',
        `${REPO}/api-user@sha256:${r.rows[0].match(/sha256:(\w+)/)[1]}`,
        'pushed',
      ],
      [
        'web',
        `${REPO}/web@sha256:${r.rows[1].match(/sha256:(\w+)/)[1]}`,
        'unchanged',
      ],
      [
        'dev-seed',
        `${REPO}/dev-seed@sha256:${r.rows[2].match(/sha256:(\w+)/)[1]}`,
        'pushed',
      ],
    ],
  );
  for (const row of r.rows) assert.match(row, /@sha256:[0-9a-f]{64}`/);
});

test('each build keeps its own layer cache scope, its content tag and the commit label', () => {
  const r = push(['api-admin']);
  assert.equal(r.status, 0, r.err);
  const [build] = r.builds;
  assert.ok(
    build.includes(`--tag ${REPO}/api-admin:${r.tags['api-admin']}`),
    build,
  );
  assert.ok(
    build.includes('--cache-from type=gha,version=2,scope=api-admin'),
    build,
  );
  assert.ok(
    build.includes('--cache-to type=gha,version=2,scope=api-admin,mode=max'),
    build,
  );
  assert.ok(build.includes('--provenance=false --sbom=false'), build);
  assert.ok(
    build.includes(`org.opencontainers.image.revision=${'f'.repeat(40)}`),
    build,
  );
});

test('a failed build fails the run, and the others still finish', () => {
  const r = push(['api-user', 'web', 'workflow'], { fail: ['web'] });
  assert.equal(r.status, 1);
  assert.match(r.rows[1], /`web` \| \| failed/);
  assert.match(r.rows[0], /api-user@sha256:.* \| pushed/);
  assert.match(r.rows[2], /workflow@sha256:.* \| pushed/);
  assert.match(r.err, /boom: web/);
});

test('an image without a digest fails the run rather than leaving an empty one', () => {
  const r = push(['api-public-read'], { nodigest: ['api-public-read'] });
  assert.equal(r.status, 1);
  assert.match(r.rows[0], /failed/);
});

test('refuses to run without services or a repository', () => {
  assert.equal(
    spawnSync(script, [], { encoding: 'utf8', env: { REPO } }).status,
    64,
  );
  assert.equal(
    spawnSync(script, ['web'], { encoding: 'utf8', env: {} }).status,
    64,
  );
});
