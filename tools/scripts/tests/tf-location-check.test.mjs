// tools/scripts/tf-location-check.sh on sample `tofu show -json` plans: what it lets through,
// what it refuses, and that it prints nothing but addresses, attribute paths and locations.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const script = join(repo, 'tools/scripts/tf-location-check.sh');
const scratch = mkdtempSync(join(tmpdir(), 'tf-location-check-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A `tofu providers schema -json` block: attribute names (string type) and nested blocks.
const block = (attributes = [], blockTypes = {}) => ({
  attributes: Object.fromEntries(
    attributes.map((name) => [name, { type: 'string', optional: true }]),
  ),
  block_types: Object.fromEntries(
    Object.entries(blockTypes).map(([name, b]) => [
      name,
      { nesting_mode: 'list', block: b },
    ]),
  ),
});
// Just enough of the google provider's schema for these tests, shaped like the real one.
const googleSchema = {
  google_storage_bucket: block(['name', 'location', 'self_link']),
  google_secret_manager_secret: block(['secret_id'], {
    replication: block([], {
      auto: block([], { customer_managed_encryption: block(['kms_key_name']) }),
      user_managed: block([], {
        replicas: block(['location'], {
          customer_managed_encryption: block(['kms_key_name']),
        }),
      }),
    }),
  }),
  google_pubsub_topic: block(['name'], {
    message_storage_policy: block(['allowed_persistence_regions']),
  }),
  google_app_engine_application: block(['location_id']),
  google_spanner_instance: block(['config', 'name']),
  google_redis_instance: block([
    'region',
    'location_id',
    'alternative_location_id',
    'current_location_id',
  ]),
  google_sql_database_instance: {
    ...block(['name', 'region', 'self_link'], {
      settings: block(['tier', 'time_zone'], {
        backup_configuration: block(['enabled', 'location']),
        ip_configuration: block(['ipv4_enabled']),
        location_preference: block(['zone']),
      }),
    }),
    // An attribute of object type: its field names count too.
    attributes: {
      name: { type: 'string' },
      region: { type: 'string' },
      self_link: { type: 'string', computed: true },
      ip_address: {
        type: ['list', ['object', { ip_address: 'string', type: 'string' }]],
        computed: true,
      },
      replica_names: {
        type: ['list', ['object', { name: 'string', zone: 'string' }]],
        computed: true,
      },
    },
  },
  google_compute_region_disk: block(['name', 'region', 'replica_zones']),
};
const schemaFile = (resourceSchemas) => {
  const file = join(
    scratch,
    `schema-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify({
      format_version: '1.0',
      provider_schemas: {
        'registry.opentofu.org/hashicorp/google': {
          resource_schemas: Object.fromEntries(
            Object.entries(resourceSchemas).map(([type, b]) => [
              type,
              { version: 0, block: b },
            ]),
          ),
        },
      },
    }),
  );
  return file;
};
const defaultSchema = schemaFile(googleSchema);

// Outside dev (blocking) unless told otherwise; with the schema above unless `schema` says
// otherwise (null: none given).
const check = (
  resourceChanges,
  environment = 'prod',
  schema = defaultSchema,
) => {
  const result = spawnSync(
    script,
    schema === null ? [environment] : [environment, schema],
    {
      encoding: 'utf8',
      input: JSON.stringify({ resource_changes: resourceChanges }),
    },
  );
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

test('an empty plan passes and an unreadable or missing one fails', () => {
  assert.equal(check([]).stdout, 'location-check: ok (0 created or updated)\n');
  const missing = spawnSync(script, ['prod'], { encoding: 'utf8', input: '' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, 'location-check: could not parse plan\n');
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

test('sensitivity inherited from a parent block hides the special-case values too', () => {
  const result = check([
    rc(
      'google_pubsub_topic.t',
      {
        message_storage_policy: [
          { allowed_persistence_regions: ['SECRET-region'] },
        ],
      },
      { after_sensitive: { message_storage_policy: true } },
    ),
    rc(
      'bunnynet_storage_zone.z',
      { region: 'UK', replication_regions: ['SECRET-region'] },
      { after_sensitive: true },
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

test("Secret Manager's automatic replication known only after apply fails", () => {
  // A dynamic `auto` block: the plan knows nothing of it but that it's there.
  const result = check([
    rc(
      'google_secret_manager_secret.dyn',
      { replication: [{ user_managed: [] }] },
      { after_unknown: { replication: [{ auto: true }] } },
    ),
    rc('google_secret_manager_secret.second', {
      replication: [{ user_managed: [] }, { auto: [{}] }],
    }),
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /secret\.dyn: replication\[0\]\.auto=\(known after apply\)/,
  );
  assert.match(result.stdout, /secret\.second: replication\.auto=global/);
});

test('Google location attributes under other names are checked too', () => {
  const result = check([
    rc('google_firestore_database.db', { location_id: 'us-central1' }),
    rc('google_container_cluster.c', {
      location: 'europe-west2',
      node_locations: ['europe-west2-a', 'us-east1-b'],
    }),
    rc('google_storage_bucket.dual', {
      location: 'EUROPE-WEST2',
      custom_placement_config: [{ data_locations: ['EUROPE-WEST1'] }],
    }),
    rc('google_logging_organization_settings.o', { storage_location: 'EU' }),
    rc('google_spanner_instance.s', { config: 'regional-us-central1' }),
    rc(
      'google_app_engine_application.later',
      {},
      { after_unknown: { location_id: true } },
    ),
    rc(
      'google_spanner_instance.later',
      {},
      { after_unknown: { config: true } },
    ),
  ]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    [
      'location-check: google_firestore_database.db: location_id=us-central1',
      'location-check: google_container_cluster.c: node_locations[1]=us-east1-b',
      'location-check: google_storage_bucket.dual: custom_placement_config[0].data_locations[0]=EUROPE-WEST1',
      'location-check: google_logging_organization_settings.o: storage_location=EU',
      'location-check: google_spanner_instance.s: config=regional-us-central1',
      'location-check: google_app_engine_application.later: location_id=(known after apply)',
      'location-check: google_spanner_instance.later: config=(known after apply)',
      'location-check: 7 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
});

test('London under those names passes, and names that are not places are ignored', () => {
  const result = check([
    rc('google_firestore_database.db', { location_id: 'europe-west2' }),
    rc('google_redis_instance.r', {
      region: 'europe-west2',
      location_id: 'europe-west2-a',
      alternative_location_id: 'europe-west2-b',
    }),
    rc('google_spanner_instance.s', {
      config: 'projects/p/instanceConfigs/regional-europe-west2',
    }),
    rc(
      'google_sql_database_instance.db',
      {
        region: 'europe-west2',
        settings: [
          {
            time_zone: 'America/New_York',
            location_preference: [{ zone: 'europe-west2-a' }],
          },
        ],
      },
      { after_unknown: { settings: [{ time_zone: true }] } },
    ),
    rc('google_cloud_run_v2_service.api', {
      location: 'europe-west2',
      build_config: [{ source_location: 'gs://us-bucket/src.zip' }],
    }),
    rc('google_dns_record_set.r', { managed_zone: 'heisreal-us' }),
    rc(
      'google_redis_instance.computed',
      { location_id: 'europe-west2-a' },
      { after_unknown: { current_location_id: true } },
    ),
    // Only Google resources get the wider names: Bunny's CDN routing zones are continents
    // it serves from, not where data is stored.
    rc('bunnynet_pullzone.images', { routing: [{ zones: ['EU', 'US'] }] }),
  ]);
  assert.equal(result.status, 0, result.all);
});

test('an unknown block or attribute whose schema holds a location is a finding', () => {
  // A dynamic backup_configuration: the plan says only that the block is unknown, so its
  // `location` (us-central1 in the config) can't be seen.
  const result = check([
    rc(
      'google_sql_database_instance.db',
      { region: 'europe-west2', settings: [{ tier: 'db-f1-micro' }] },
      {
        after_unknown: {
          settings: [{ backup_configuration: true }],
          replica_names: true,
        },
      },
    ),
    rc(
      'google_sql_database_instance.whole',
      { region: 'europe-west2' },
      { after_unknown: { settings: true } },
    ),
  ]);
  assert.equal(result.status, 1, result.all);
  assert.equal(
    result.stdout,
    [
      'location-check: google_sql_database_instance.db: settings[0].backup_configuration=(known after apply)',
      'location-check: google_sql_database_instance.db: replica_names=(known after apply)',
      'location-check: google_sql_database_instance.whole: settings=(known after apply)',
      'location-check: 3 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
});

test('unknown values whose schema holds no location pass', () => {
  const result = check([
    rc(
      'google_sql_database_instance.db',
      { region: 'europe-west2', settings: [{ tier: 'db-f1-micro' }] },
      {
        after_unknown: {
          self_link: true,
          ip_address: true,
          settings: [{ ip_configuration: true }],
        },
      },
    ),
    rc(
      'google_secret_manager_secret.cmek',
      { replication: [{ auto: [{}] }] },
      {
        after_unknown: {
          replication: [{ auto: [{ customer_managed_encryption: true }] }],
        },
      },
    ),
  ]);
  // The `auto` block itself is a finding (global); its unknown encryption key is not.
  assert.equal(
    result.stdout,
    [
      'location-check: google_secret_manager_secret.cmek: replication.auto=global',
      'location-check: 1 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
});

test('without the provider schema, unknown Google values fail closed outside dev', () => {
  const plan = [
    rc(
      'google_sql_database_instance.db',
      { region: 'europe-west2' },
      { after_unknown: { self_link: true } },
    ),
    rc('google_storage_bucket.known', { location: 'EUROPE-WEST2' }),
    rc('bunnynet_pullzone.p', { name: 'p' }, { after_unknown: { id: true } }),
  ];
  const expected = [
    'location-check: google_sql_database_instance.db: self_link=(known after apply; no provider schema to rule out a location)',
  ];
  for (const schema of [null, join(scratch, 'missing.json'), schemaFile({})]) {
    const result = check(plan, 'prod', schema);
    assert.equal(result.status, 1, `${schema}: ${result.all}`);
    assert.equal(
      result.stdout,
      [
        ...expected,
        'location-check: 1 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
        '',
      ].join('\n'),
      String(schema),
    );
  }
  const unreadable = join(scratch, 'unreadable.json');
  writeFileSync(unreadable, '{"provider_schemas": SECRET');
  const garbled = check(plan, 'prod', unreadable);
  assert.equal(garbled.status, 1);
  assert.doesNotMatch(garbled.all, /SECRET/);
  const dev = check(plan, 'dev', null);
  assert.equal(dev.status, 0);
  assert.match(dev.stdout, /no provider schema to rule out a location/);
  assert.match(dev.stdout, /WARNING: 1 outside the UK/);
});

test('Compute zone and region links are compared by their last segment', () => {
  const link = 'https://www.googleapis.com/compute/v1/projects/p';
  const result = check([
    rc('google_compute_region_disk.ok', {
      region: `${link}/regions/europe-west2`,
      replica_zones: [
        `${link}/zones/europe-west2-a`,
        'projects/p/zones/europe-west2-b',
      ],
    }),
    rc('google_compute_region_disk.bad', {
      region: 'europe-west2',
      replica_zones: [
        `${link}/zones/europe-west2-a`,
        `${link}/zones/us-central1-a`,
      ],
    }),
    rc('google_storage_bucket.not_a_link', {
      location: 'projects/p/buckets/zones/europe-west2',
    }),
  ]);
  assert.equal(result.status, 1, result.all);
  assert.equal(
    result.stdout,
    [
      `location-check: google_compute_region_disk.bad: replica_zones[1]=${link}/zones/us-central1-a`,
      'location-check: google_storage_bucket.not_a_link: location=projects/p/buckets/zones/europe-west2',
      'location-check: 2 outside the UK; fix them, or record an exception in tools/scripts/tf-location-check.sh',
      '',
    ].join('\n'),
  );
});

test("unknown GKE zones pass: Google picks them inside the cluster's checked location", () => {
  const unknown = {
    node_locations: true,
    node_pool: true,
    cluster_autoscaling: [{ auto_provisioning_locations: true }],
  };
  const ok = check(
    [
      rc(
        'google_container_cluster.c',
        { location: 'europe-west2', cluster_autoscaling: [{}] },
        { after_unknown: unknown },
      ),
    ],
    'prod',
    schemaFile({
      google_container_cluster: block(['location', 'node_locations'], {
        node_pool: block(['node_locations']),
        cluster_autoscaling: block(['auto_provisioning_locations']),
      }),
    }),
  );
  assert.equal(ok.stdout, 'location-check: ok (1 created or updated)\n');
  // The cluster's own location and known zones are still checked.
  const bad = check([
    rc(
      'google_container_cluster.c',
      { node_locations: ['us-east1-b'] },
      { after_unknown: { location: true } },
    ),
  ]);
  assert.match(
    bad.stdout,
    /c: node_locations\[0\]=us-east1-b\n.*c: location=\(known after apply\)/s,
  );
});
