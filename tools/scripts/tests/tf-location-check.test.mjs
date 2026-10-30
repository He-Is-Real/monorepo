// tools/scripts/tf-location-check.sh on sample `tofu show -json` plans: what it lets through,
// what it refuses, and that it prints nothing but addresses, attribute paths and locations.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const script = join(repo, 'tools/scripts/tf-location-check.sh');

// Outside dev (blocking) unless told otherwise.
const check = (resourceChanges, environment = 'prod') => {
  const result = spawnSync(script, [environment], {
    encoding: 'utf8',
    input: JSON.stringify({ resource_changes: resourceChanges }),
  });
  return { ...result, all: result.stdout + result.stderr };
};

// One managed resource change; `change` overrides the defaults.
const rc = (address, after, change = {}) => ({
  address,
  mode: 'managed',
  type: address
    .split('.')
    .at(-2)
    .replace(/\[.*\]$/, ''),
  change: {
    actions: ['create'],
    after,
    after_unknown: {},
    after_sensitive: {},
    ...change,
  },
});

test('London, its zones and the bucket spelling pass', () => {
  const result = check([
    rc('google_container_cluster.dev', { location: 'europe-west2' }),
    rc('google_compute_subnetwork.gke', { region: 'europe-west2' }),
    rc('google_compute_disk.db', { zone: 'europe-west2-c' }),
    rc('google_storage_bucket.backups', { location: 'EUROPE-WEST2' }),
    rc('module.gcp.google_secret_manager_secret.s["a"]', {
      replication: [
        {
          auto: [],
          user_managed: [{ replicas: [{ location: 'europe-west2' }] }],
        },
      ],
    }),
  ]);
  assert.equal(result.status, 0, result.all);
  assert.equal(result.stdout, 'location-check: ok (5 created or updated)\n');
});

test('anything else fails, whatever the key case or depth, and prints only the location', () => {
  const result = check([
    rc('google_storage_bucket.eu', { location: 'EU', name: 'SECRET-name' }),
    rc('google_cloud_run_v2_service.api', {
      Location: 'us-central1',
      template: [{ env: [{ name: 'X', value: 'SECRET' }] }],
    }),
    rc('google_compute_instance.vm', { zone: 'europe-west2-d' }),
    rc('module.gcp.google_secret_manager_secret.s', {
      replication: [
        { user_managed: [{ replicas: [{ location: 'europe-west1' }] }] },
      ],
    }),
    rc('google_artifact_registry_repository.r', { location: 'europe' }),
  ]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    [
      'location-check: google_storage_bucket.eu: location=EU',
      'location-check: google_cloud_run_v2_service.api: Location=us-central1',
      'location-check: google_compute_instance.vm: zone=europe-west2-d',
      'location-check: module.gcp.google_secret_manager_secret.s: replication[0].user_managed[0].replicas[0].location=europe-west1',
      'location-check: google_artifact_registry_repository.r: location=europe',
      'location-check: 5 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
  assert.doesNotMatch(result.all, /SECRET/);
});

test('updates and replacements are checked; deletes, no-ops and data sources are not', () => {
  const result = check([
    rc(
      'google_storage_bucket.updated',
      { location: 'US' },
      { actions: ['update'] },
    ),
    rc(
      'google_storage_bucket.replaced',
      { location: 'US' },
      { actions: ['delete', 'create'] },
    ),
    rc('google_storage_bucket.deleted', null, {
      actions: ['delete'],
      before: { location: 'US' },
    }),
    rc(
      'google_storage_bucket.same',
      { location: 'US' },
      { actions: ['no-op'] },
    ),
    {
      ...rc(
        'data.google_storage_bucket.read',
        { location: 'US' },
        { actions: ['read'] },
      ),
      mode: 'data',
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /google_storage_bucket\.updated: location=US/);
  assert.match(result.stdout, /google_storage_bucket\.replaced: location=US/);
  assert.match(result.stdout, /: 2 outside the UK/);
});

test('a location known only after apply, or a sensitive one, fails without its value', () => {
  const result = check([
    rc(
      'google_storage_bucket.later',
      {},
      { after_unknown: { location: true } },
    ),
    rc(
      'google_storage_bucket.hidden',
      { location: 'SECRET' },
      { after_sensitive: { location: true } },
    ),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /later: location=\(known after apply\)/);
  assert.match(result.stdout, /hidden: location=\(sensitive\)/);
  assert.doesNotMatch(result.all, /SECRET/);
});

test('Pub/Sub topics must keep messages in London', () => {
  const topic = (name, policy) =>
    rc(`google_pubsub_topic.${name}`, {
      name: 'SECRET',
      message_storage_policy: policy,
    });
  const result = check([
    topic('ok', [
      {
        allowed_persistence_regions: ['europe-west2'],
        enforce_in_transit: true,
      },
    ]),
    topic('missing', []),
    topic('wider', [
      { allowed_persistence_regions: ['europe-west2', 'europe-west1'] },
    ]),
  ]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    [
      'location-check: google_pubsub_topic.missing: message_storage_policy.allowed_persistence_regions=(not declared)',
      'location-check: google_pubsub_topic.wider: message_storage_policy.allowed_persistence_regions=europe-west2,europe-west1',
      'location-check: 2 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
});

test("Secret Manager's automatic (global) replication fails", () => {
  const result = check([
    rc('google_secret_manager_secret.auto', {
      replication: [{ auto: [{}], user_managed: [] }],
    }),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /secret\.auto: replication\.auto=global/);
});

test('genuinely global types are skipped; global elsewhere fails', () => {
  const result = check([
    rc('google_project_service.run', {
      service: 'run.googleapis.com',
      location: 'global',
    }),
    rc('google_service_account.api', { account_id: 'api' }),
    rc('google_kms_key_ring.tofu', { location: 'global' }),
  ]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout.split('\n')[0],
    'location-check: google_kms_key_ring.tofu: location=global',
  );
  assert.match(result.stdout, /: 1 outside the UK/);
});

test("Bunny: images in London, only Stream's zone in Frankfurt, nothing replicated", () => {
  const zone = (address, region, replication_regions = []) =>
    rc(
      address,
      { region, replication_regions, password: 'SECRET' },
      {
        after_sensitive: { password: true },
      },
    );
  const ok = check([
    zone('module.bunny.bunnynet_storage_zone.images', 'UK'),
    zone('module.bunny.bunnynet_storage_zone.stream[0]', 'DE'),
    rc('bunnynet_dns_record.www', { zone: 123 }),
    rc('bunnynet_storage_file.logo', { zone: 'heisreal-images' }),
  ]);
  assert.equal(ok.status, 0, ok.all);

  const bad = check([
    zone('module.bunny.bunnynet_storage_zone.images', 'DE'),
    zone('module.bunny.bunnynet_storage_zone.stream[0]', 'NY'),
    zone('module.bunny.bunnynet_storage_zone.other', 'UK', ['DE']),
  ]);
  assert.equal(bad.status, 1);
  assert.equal(
    bad.stdout,
    [
      'location-check: module.bunny.bunnynet_storage_zone.images: region=DE',
      'location-check: module.bunny.bunnynet_storage_zone.stream[0]: region=NY',
      'location-check: module.bunny.bunnynet_storage_zone.other: replication_regions=DE',
      'location-check: 3 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
  assert.doesNotMatch(bad.all, /SECRET/);
});

test('an empty plan passes and an unreadable one fails', () => {
  assert.equal(check([]).stdout, 'location-check: ok (0 created or updated)\n');
  const result = spawnSync(script, ['prod'], {
    encoding: 'utf8',
    input: 'not json SECRET',
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout + result.stderr,
    'location-check: could not parse plan\n',
  );
});

test('dev reports the same findings but never blocks', () => {
  const result = check(
    [
      rc('google_storage_bucket.eu', { location: 'EU', name: 'SECRET' }),
      rc('google_pubsub_topic.t', { message_storage_policy: [] }),
    ],
    'dev',
  );
  assert.equal(result.status, 0, result.all);
  assert.equal(
    result.stdout,
    [
      'location-check: google_storage_bucket.eu: location=EU',
      'location-check: google_pubsub_topic.t: message_storage_policy.allowed_persistence_regions=(not declared)',
      'location-check: WARNING: 2 outside the UK (dev: reported only; outside dev this fails the plan)',
      '',
    ].join('\n'),
  );
  assert.doesNotMatch(result.all, /SECRET/);
  const unreadable = spawnSync(script, ['dev'], {
    encoding: 'utf8',
    input: 'not json SECRET',
  });
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.stdout, /WARNING: could not parse plan \(dev: /);
  assert.doesNotMatch(unreadable.stdout + unreadable.stderr, /SECRET/);
});

test('every environment but dev blocks, and one must be named', () => {
  const outside = [rc('google_storage_bucket.us', { location: 'US' })];
  for (const environment of ['prod', 'staging', 'Dev', 'dev2']) {
    assert.equal(check(outside, environment).status, 1, environment);
  }
  assert.equal(spawnSync(script, [], { input: '{}' }).status, 64);
  assert.equal(spawnSync(script, [''], { input: '{}' }).status, 64);
});

test('an unknown container that holds locations is a finding (known after apply)', () => {
  const result = check([
    rc(
      'google_secret_manager_secret.s',
      { replication: [{ user_managed: [{}] }] },
      {
        after_unknown: {
          replication: [{ user_managed: [{ replicas: true }] }],
        },
      },
    ),
    rc(
      'google_secret_manager_secret.whole',
      {},
      { after_unknown: { replication: true } },
    ),
    rc(
      'google_pubsub_topic.t',
      {},
      { after_unknown: { message_storage_policy: true } },
    ),
    rc(
      'bunnynet_storage_zone.z',
      { region: 'UK' },
      { after_unknown: { replication_regions: true } },
    ),
    rc(
      'bunnynet_pullzone.p',
      { name: 'p' },
      { after_unknown: { storagezone: true, zone_id: true } },
    ),
    rc(
      'google_secret_manager_secret.cmek',
      {
        replication: [
          { user_managed: [{ replicas: [{ location: 'europe-west2' }] }] },
        ],
      },
      {
        after_unknown: {
          replication: [
            {
              user_managed: [
                { replicas: [{ customer_managed_encryption: true }] },
              ],
            },
          ],
        },
      },
    ),
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /secret\.s: replication\[0\]\.user_managed\[0\]\.replicas=\(known after apply\)/,
  );
  assert.match(
    result.stdout,
    /secret\.whole: replication=\(known after apply\)/,
  );
  assert.match(
    result.stdout,
    /topic\.t: message_storage_policy=\(known after apply\)/,
  );
  assert.match(
    result.stdout,
    /zone\.z: replication_regions=\(known after apply\)/,
  );
  assert.doesNotMatch(result.stdout, /pullzone|cmek/);
});

test('Pub/Sub and Bunny replication findings respect sensitivity', () => {
  const result = check([
    rc(
      'google_pubsub_topic.t',
      {
        message_storage_policy: [
          { allowed_persistence_regions: ['SECRET-region'] },
        ],
      },
      {
        after_sensitive: {
          message_storage_policy: [{ allowed_persistence_regions: [true] }],
        },
      },
    ),
    rc(
      'bunnynet_storage_zone.z',
      { region: 'UK', replication_regions: ['SECRET-region'] },
      { after_sensitive: { replication_regions: true } },
    ),
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /topic\.t: message_storage_policy\.allowed_persistence_regions=\(sensitive\)/,
  );
  assert.match(result.stdout, /zone\.z: replication_regions=\(sensitive\)/);
  assert.doesNotMatch(result.all, /SECRET/);
});
