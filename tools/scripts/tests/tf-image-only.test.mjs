// tools/scripts/tf-image-only.mjs: D120 (Joel, 2026-10-30), a dev gcp plan applies without the
// approval only when every change is a Cloud Run service or job moving to a new image digest
// from our own `apps` repository. Everything else waits for the `dev` approval, and production
// never applies on its own. Plans are shaped as `tofu show -json` writes them.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../tf-image-only.mjs';

const script = fileURLToPath(new URL('../tf-image-only.mjs', import.meta.url));
const REGISTRY = 'europe-west2-docker.pkg.dev/heisreal-dev';
const digest = (c) => `sha256:${c.repeat(64)}`;
const image = (svc, c, repo = 'apps') =>
  `${REGISTRY}/${repo}/${svc}@${digest(c)}`;

/** A Cloud Run service as the provider holds it, running `img`. */
const service = (name, img, extra = {}) => ({
  name,
  project: 'heisreal-dev',
  location: 'europe-west2',
  labels: {},
  etag: '"abc"',
  generation: '7',
  latest_ready_revision: `${name}-00007-xyz`,
  template: [
    {
      max_instance_request_concurrency: 80,
      service_account: `${name}@heisreal-dev.iam.gserviceaccount.com`,
      containers: [
        {
          name: '',
          image: img,
          env: [{ name: 'SITE_URL', value: 'https://example.test' }],
          ports: [{ container_port: 8080, name: 'http1' }],
        },
      ],
    },
  ],
  ...extra,
});

/** An in-place update from `before` to `after`, with Google's computed fields unknown. */
const update = (
  address,
  before,
  after,
  type = 'google_cloud_run_v2_service',
) => {
  const { etag, generation, latest_ready_revision, ...known } = after;
  return {
    address,
    mode: 'managed',
    type,
    name: address.split('.').pop(),
    change: {
      actions: ['update'],
      before,
      after: known,
      after_unknown: {
        etag: true,
        generation: true,
        latest_ready_revision: true,
        update_time: true,
        conditions: true,
        template: [{ containers: [{ env: [{}], ports: [{}] }] }],
      },
    },
  };
};

const webUpdate = () =>
  update(
    'module.gcp.google_cloud_run_v2_service.web',
    service('web', image('web', 'a')),
    service('web', image('web', 'b')),
  );

const plan = (...changes) => ({
  format_version: '1.2',
  applyable: true,
  errored: false,
  resource_changes: changes,
  output_changes: { web_url: { actions: ['no-op'] } },
});

const noop = {
  address: 'module.gcp.google_project_iam_member.x',
  mode: 'managed',
  type: 'google_project_iam_member',
  change: { actions: ['no-op'], before: {}, after: {}, after_unknown: {} },
};

test('image digests from apps on Cloud Run services and the job → auto, listing each', () => {
  const job = (img) => ({
    name: 'dev-seed',
    project: 'heisreal-dev',
    etag: '"j"',
    generation: '3',
    latest_ready_revision: 'x',
    template: [{ template: [{ containers: [{ image: img }] }] }],
  });
  const jobUpdate = update(
    'module.gcp.google_cloud_run_v2_job.dev_seed',
    job(image('dev-seed', 'c')),
    job(image('dev-seed', 'd')),
    'google_cloud_run_v2_job',
  );
  jobUpdate.change.after_unknown.template = [
    { template: [{ containers: [{}] }] },
  ];
  assert.deepEqual(decide('dev', plan(webUpdate(), noop, jobUpdate)), {
    auto: true,
    images: [
      ['web', image('web', 'b')],
      ['dev-seed', image('dev-seed', 'd')],
    ],
  });
});

test('production, or any environment but dev, never applies on its own', () => {
  for (const env of ['prod', 'production', 'staging', '', undefined])
    assert.equal(decide(env, plan(webUpdate())).auto, false, String(env));
  assert.match(decide('prod', plan(webUpdate())).reason, /only dev/);
});

test('create, delete, replace, read, import or move → approval', () => {
  for (const actions of [
    ['create'],
    ['delete'],
    ['delete', 'create'],
    ['create', 'delete'],
    ['read'],
  ]) {
    const rc = webUpdate();
    rc.change.actions = actions;
    assert.equal(decide('dev', plan(rc)).auto, false, actions.join(','));
  }
  const imported = webUpdate();
  imported.change.importing = { id: 'x' };
  assert.equal(decide('dev', plan(imported)).auto, false);
  const moved = webUpdate();
  moved.previous_address = 'module.gcp.google_cloud_run_v2_service.old';
  assert.equal(decide('dev', plan(moved)).auto, false);
  // An import or move with nothing else to change is a no-op, and still not an image update.
  const noopImport = structuredClone(noop);
  noopImport.change.importing = { id: 'projects/heisreal-dev/roles/x' };
  assert.equal(decide('dev', plan(webUpdate(), noopImport)).auto, false);
  const noopMove = structuredClone(noop);
  noopMove.previous_address = 'module.gcp.google_project_iam_member.old';
  assert.equal(decide('dev', plan(webUpdate(), noopMove)).auto, false);
});

test('anything but Cloud Run → approval: IAM, secrets, the database, Bunny, Stripe', () => {
  for (const type of [
    'google_project_iam_member',
    'google_cloud_run_v2_service_iam_member',
    'google_secret_manager_secret_version',
    'google_container_cluster',
    'kustomization_resource',
    'bunnynet_pullzone',
    'stripe_price',
  ]) {
    const rc = webUpdate();
    rc.type = type;
    assert.equal(decide('dev', plan(rc)).auto, false, type);
  }
  const data = webUpdate();
  data.mode = 'data';
  assert.equal(decide('dev', plan(data)).auto, false);
});

test('an image change plus any other change on the service → approval', () => {
  const cases = {
    env: (s) =>
      (s.template[0].containers[0].env[0].value = 'https://other.test'),
    'service account': (s) =>
      (s.template[0].service_account =
        'other@heisreal-dev.iam.gserviceaccount.com'),
    labels: (s) => (s.labels = { team: 'x' }),
    'a second container': (s) =>
      s.template[0].containers.push({
        name: 'sidecar',
        image: image('web', 'c'),
      }),
    'ingress (top level)': (s) => (s.ingress = 'INGRESS_TRAFFIC_ALL'),
  };
  for (const [what, change] of Object.entries(cases)) {
    const after = service('web', image('web', 'b'));
    change(after);
    const rc = update(
      'module.gcp.google_cloud_run_v2_service.web',
      service('web', image('web', 'a')),
      after,
    );
    assert.equal(decide('dev', plan(rc)).auto, false, what);
  }
  // A configurable attribute only known after apply is a change we can't read: approval.
  const rc = webUpdate();
  rc.change.after_unknown.template[0].service_account = true;
  assert.equal(decide('dev', plan(rc)).auto, false);
});

// A real dev plan (2026-10-30, google provider 8.7.0) that moves web to an older apps digest,
// trimmed to that change, with the env values redacted.
const realPlan = () =>
  JSON.parse(
    readFileSync(new URL('fixtures/dev-plan-web-image.json', import.meta.url)),
  );

test('a real dev plan that changes only the web image → auto', () => {
  const result = decide('dev', realPlan());
  assert.equal(result.auto, true, result.reason);
  assert.deepEqual(
    result.images.map(([s]) => s),
    ['web'],
  );
});

test('labels the provider adds (default_labels) or annotations change with the image → approval', () => {
  // The provider sends effective_labels to Cloud Run, merged from the resource's labels and the
  // provider's default_labels, so a default_labels change alone is a real cloud change.
  const cases = {
    'a default label changes': (c) => {
      c.after.terraform_labels.team = 'x';
      c.after.effective_labels.team = 'x';
    },
    'only effective_labels changes': (c) =>
      (c.after.effective_labels.team = 'x'),
    'terraform_labels becomes unknown': (c) => {
      delete c.after.terraform_labels;
      c.after_unknown.terraform_labels = true;
    },
    'effective_labels becomes unknown': (c) => {
      delete c.after.effective_labels;
      c.after_unknown.effective_labels = true;
    },
    'effective_annotations changes': (c) =>
      (c.after.effective_annotations = { a: 'b' }),
  };
  for (const [what, change] of Object.entries(cases)) {
    const p = realPlan();
    change(p.resource_changes[0].change);
    assert.equal(decide('dev', p).auto, false, what);
    assert.match(
      decide('dev', p).reason,
      /_(labels|annotations)\b.* changes$/,
      what,
    );
  }
});

test('an image that is not a digest from our apps repository → approval', () => {
  for (const img of [
    image('web', 'b', 'apps-scratch'),
    `${REGISTRY}/apps/web:latest`,
    `us-docker.pkg.dev/cloudrun/container/hello`,
    `europe-west2-docker.pkg.dev/someone-else/apps/web@${digest('b')}`,
    `${image('web', 'b')}\nx`,
  ]) {
    const rc = update(
      'module.gcp.google_cloud_run_v2_service.web',
      service('web', image('web', 'a')),
      service('web', img),
    );
    assert.equal(decide('dev', plan(rc)).auto, false, img);
  }
});

test('another project, an unreadable, errored or empty plan → approval', () => {
  const other = update(
    'module.gcp.google_cloud_run_v2_service.web',
    service('web', image('web', 'a'), { project: 'heisreal-prod' }),
    service('web', image('web', 'b'), { project: 'heisreal-prod' }),
  );
  assert.equal(decide('dev', plan(other)).auto, false);
  assert.equal(
    decide('dev', { ...plan(webUpdate()), errored: true }).auto,
    false,
  );
  assert.equal(
    decide('dev', { ...plan(webUpdate()), applyable: false }).auto,
    false,
  );
  assert.equal(
    decide('dev', { ...plan(webUpdate()), deferred_changes: [{}] }).auto,
    false,
  );
  assert.equal(decide('dev', plan(noop)).auto, false);
  assert.equal(decide('dev', {}).auto, false);
  assert.equal(decide('dev', null).auto, false);
  const unchanged = update(
    'module.gcp.google_cloud_run_v2_service.web',
    service('web', image('web', 'a')),
    service('web', image('web', 'a')),
  );
  assert.equal(decide('dev', plan(unchanged)).auto, false);
});

test('the command prints auto and the images, or manual and why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-image-only-'));
  try {
    const file = join(dir, 'plan.json');
    writeFileSync(file, JSON.stringify(plan(webUpdate())));
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(run('dev', file).stdout, `auto\nweb ${image('web', 'b')}\n`);
    assert.match(run('prod', file).stdout, /^manual: only dev /);
    writeFileSync(file, 'not json');
    assert.equal(
      run('dev', file).stdout,
      'manual: the plan could not be read\n',
    );
    assert.equal(run('dev').status, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
