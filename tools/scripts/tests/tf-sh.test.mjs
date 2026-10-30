// tools/scripts/tf.sh against stub `tofu`, `gcloud` and `bunny` binaries on PATH: which
// identity each root runs as, what the environment looks like when tofu starts, what it
// refuses, and that the Bunny helpers never print anything but allowlisted data.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url)).replace(
  /\/$/,
  '',
);
const script = join(repo, 'tools/scripts/tf.sh');
const deployer = 'tf-deployer@heisreal-dev.iam.gserviceaccount.com';
const tfBunny = 'tf-bunny@heisreal-dev.iam.gserviceaccount.com';
// The stub reports the pinned version, so a Renovate bump of mise.toml needs no edit here.
const pinnedTofu = readFileSync(join(repo, 'mise.toml'), 'utf8').match(
  /^opentofu = "(.*)"/m,
)[1];

const stubs = mkdtempSync(join(tmpdir(), 'tf-sh-test-'));
after(() => rmSync(stubs, { recursive: true, force: true }));

const node = `#!${process.execPath}`;
const stub = (name, body) => {
  const file = join(stubs, name);
  writeFileSync(file, `${node}\n${body}\n`);
  chmodSync(file, 0o755);
};

// tofu: `version -json`, `show -json` (from STUB_SHOW_JSON, or a failure that prints SECRET),
// `providers schema -json` (from STUB_SCHEMA_JSON, else a failure that prints SECRET),
// otherwise echoes its argv and the environment variables that matter (`plan` then exits with
// STUB_PLAN_EXIT).
stub(
  'tofu',
  `
const argv = process.argv.slice(2);
const cmd = argv.filter((a) => !a.startsWith('-chdir='));
const env = process.env;
if (cmd[0] === 'version' && cmd.includes('-json')) {
  console.log(JSON.stringify({ terraform_version: env.STUB_TOFU_VERSION ?? ${JSON.stringify(pinnedTofu)} }));
  process.exit(0);
}
if (cmd[0] === 'show' && cmd.includes('-json') && (env.STUB_SHOW_JSON || env.STUB_SHOW_FAIL)) {
  if (env.STUB_SHOW_FAIL) {
    console.log('partial output SECRET');
    console.error('Error: key SECRET');
    process.exit(1);
  }
  process.stdout.write(env.STUB_SHOW_JSON);
  process.exit(0);
}
if (cmd[0] === 'providers' && cmd[1] === 'schema') {
  if (!env.STUB_SCHEMA_JSON) {
    console.log('partial SECRET');
    console.error('Error: SECRET');
    process.exit(1);
  }
  process.stdout.write(env.STUB_SCHEMA_JSON);
  process.exit(0);
}
const pick = {};
for (const k of [
  'GOOGLE_IMPERSONATE_SERVICE_ACCOUNT',
  'GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT',
  'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
  'TF_ENCRYPTION',
]) {
  if (k in env) pick[k] = env[k];
}
console.log(JSON.stringify({ argv, env: pick }));
if (cmd[0] === 'plan') process.exit(Number(env.STUB_PLAN_EXIT ?? 0));
`,
);

// gcloud: logs every call; ADC succeeds unless STUB_NO_ADC, and impersonating through ADC (flag
// or CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, as real gcloud does) fails if STUB_NO_IMPERSONATION;
// secrets list/access are canned.
stub(
  'gcloud',
  `
const fs = require('node:fs');
const argv = process.argv.slice(2);
const env = process.env;
if (env.STUB_GCLOUD_LOG) fs.appendFileSync(env.STUB_GCLOUD_LOG, JSON.stringify(argv) + '\\n');
const joined = argv.join(' ');
if (joined.startsWith('auth application-default print-access-token')) {
  if (env.STUB_NO_ADC) { console.error('no credentials'); process.exit(1); }
  const as = argv.some((a) => a.startsWith('--impersonate-service-account')) ||
    env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT;
  if (as && env.STUB_NO_IMPERSONATION) { console.error('Permission denied'); process.exit(1); }
  console.log('ya29.token');
  process.exit(0);
}
if (joined.startsWith('secrets list')) {
  process.stdout.write((env.STUB_SECRETS ?? '').replaceAll('\\\\n', '\\n') + '\\n');
  process.exit(0);
}
if (joined.startsWith('secrets versions access')) {
  const secret = argv.find((a) => a.startsWith('--secret=')).slice('--secret='.length);
  process.stdout.write('stub-' + secret);
  process.exit(0);
}
console.error('stub gcloud: unexpected ' + joined);
process.exit(2);
`,
);

// bunny: prints the key it was given.
stub(
  'bunny',
  `process.stdout.write(process.env.BUNNYNET_API_KEY ?? '<none>');`,
);

const run = (args, env = {}) => {
  const log = join(stubs, `gcloud-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '');
  const result = spawnSync(script, args, {
    encoding: 'utf8',
    env: {
      PATH: `${stubs}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: stubs,
      STUB_GCLOUD_LOG: log,
      ...env,
    },
  });
  const gcloudCalls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, gcloudCalls, all: result.stdout + result.stderr };
};

const tofuCall = (result) => {
  assert.equal(result.status, 0, result.all);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
};

const IMPERSONATION = [
  'GOOGLE_IMPERSONATE_SERVICE_ACCOUNT',
  'GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT',
  'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
];
const callerImpersonation = Object.fromEntries(
  IMPERSONATION.map((k) => [k, 'caller@x.iam.gserviceaccount.com']),
);

// Identity defaults

test('gcp defaults to tf-deployer locally', () => {
  const result = run(['gcp', 'plan'], {
    GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT:
      'other@x.iam.gserviceaccount.com',
  });
  const call = tofuCall(result);
  assert.deepEqual(call.argv.slice(0, 2), [
    `-chdir=${repo}/infra/terraform/live/dev/gcp`,
    'plan',
  ]);
  assert.equal(call.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, deployer);
  assert.equal(call.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, deployer);
  assert.ok(!('GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT' in call.env));
  assert.match(result.stderr, new RegExp(`tf.sh: gcp as ${deployer}`));
});

test('images, cluster and stripe default to tf-deployer locally', () => {
  for (const root of ['images', 'cluster', 'stripe']) {
    const call = tofuCall(run([root, 'plan']));
    assert.equal(
      call.argv[0],
      `-chdir=${repo}/infra/terraform/live/dev/${root}`,
    );
    assert.equal(call.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, deployer);
  }
});

test('bunny defaults to tf-bunny locally', () => {
  const call = tofuCall(run(['bunny', 'plan']));
  assert.equal(call.argv[0], `-chdir=${repo}/infra/terraform/live/dev/bunny`);
  assert.equal(call.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, tfBunny);
  assert.equal(call.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, tfBunny);
});

test('bootstrap never impersonates', () => {
  const call = tofuCall(run(['bootstrap', 'plan'], callerImpersonation));
  assert.equal(
    call.argv[0],
    `-chdir=${repo}/infra/terraform/live/dev/bootstrap`,
  );
  assert.deepEqual(call.env, {});
});

// Identity overrides

test('bootstrap refuses another identity', () => {
  const result = run(['bootstrap', 'plan'], { TF_SH_IDENTITY: deployer });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runs with your own credentials/);
});

test('TF_SH_IDENTITY=self uses own credentials', () => {
  const call = tofuCall(
    run(['gcp', 'plan'], { TF_SH_IDENTITY: 'self', ...callerImpersonation }),
  );
  assert.deepEqual(call.env, {});
});

test('CI uses ambient credentials', () => {
  const result = run(['gcp', 'plan'], {
    GITHUB_ACTIONS: 'true',
    ...callerImpersonation,
  });
  assert.deepEqual(tofuCall(result).env, {});
  assert.deepEqual(result.gcloudCalls, []);
});

test('explicit email wins', () => {
  const other = 'tf-planner@heisreal-dev.iam.gserviceaccount.com';
  const call = tofuCall(
    run(['gcp', 'plan'], { TF_SH_IDENTITY: other, GITHUB_ACTIONS: 'true' }),
  );
  assert.equal(call.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, other);
  assert.equal(call.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, other);
});

test('bad identity refused', () => {
  const result = run(['gcp', 'plan'], { TF_SH_IDENTITY: 'deployer' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /TF_SH_IDENTITY/);
});

// Environment hygiene and refusals

test('env encryption cleared', () => {
  const call = tofuCall(
    run(['gcp', 'plan'], { TF_ENCRYPTION: 'key_provider "pbkdf2" "x" {}' }),
  );
  assert.ok(!('TF_ENCRYPTION' in call.env));
});

test('debug logs refused', () => {
  for (const env of [
    { TF_LOG: 'trace' },
    { TF_LOG_CORE: 'trace' },
    { TF_LOG_PROVIDER: 'debug' },
    { TF_LOG_PATH: '/tmp/x.log' },
    { RUNNER_DEBUG: '1' },
  ]) {
    for (const root of ['gcp', 'bunny']) {
      const result = run([root, 'plan'], env);
      assert.equal(result.status, 1, `${root} ${JSON.stringify(env)}`);
      assert.match(
        result.stderr,
        /debug logs can print secrets into public CI logs/,
      );
      assert.doesNotMatch(result.stdout, /argv/);
    }
  }
});

test('unknown root refused', () => {
  const result = run(['prod', 'plan']);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /bootstrap\|gcp\|images\|cluster\|bunny/);
});

test('no arguments is a usage error', () => {
  assert.equal(run([]).status, 64);
  assert.equal(run(['gcp']).status, 64);
});

test('version mismatch refused', () => {
  const result = run(['gcp', 'plan'], { STUB_TOFU_VERSION: '1.12.0' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`expected ${pinnedTofu}`), result.stderr);
});

test('no ADC refused locally', () => {
  const result = run(['gcp', 'plan'], { STUB_NO_ADC: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gcloud auth login --update-adc/);
});

test('failed impersonation is not reported as missing ADC', () => {
  const result = run(['bunny', 'plan'], { STUB_NO_IMPERSONATION: '1' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Application Default Credentials/);
  assert.match(result.stderr, new RegExp(`couldn't impersonate ${tfBunny}`));
  assert.match(result.stderr, /bootstrap/);
  assert.match(result.stderr, /TF_SH_IDENTITY=self/);
  assert.ok(!result.stdout.includes('argv'), 'tofu must not run');
});

test('own credentials skip the impersonation check', () => {
  const result = run(['bunny', 'plan'], {
    TF_SH_IDENTITY: 'self',
    STUB_NO_IMPERSONATION: '1',
  });
  tofuCall(result);
  assert.ok(
    !result.gcloudCalls.some((c) =>
      c.some((a) => a.startsWith('--impersonate-service-account')),
    ),
  );
});

test('bunny refuses state pull and json', () => {
  for (const args of [
    ['state', 'pull'],
    ['show', '-json', 'x'],
    ['output', '-json'],
  ]) {
    const result = run(['bunny', ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /plan-summary/);
  }
  assert.deepEqual(tofuCall(run(['bunny', 'plan', '-out=x'])).argv.slice(1), [
    'plan',
    '-out=x',
  ]);
});

test('other roots may use show -json', () => {
  assert.deepEqual(tofuCall(run(['gcp', 'show', '-json', 'x'])).argv.slice(1), [
    'show',
    '-json',
    'x',
  ]);
});

// plan-summary

const plan = JSON.stringify({
  resource_changes: [
    {
      address: 'module.bunny.bunnynet_stream_library.media',
      change: {
        actions: ['update'],
        before: { api_key: 'SECRET' },
        after: { api_key: 'SECRET' },
      },
    },
    {
      address: 'module.bunny.bunnynet_pullzone.media',
      change: {
        actions: ['no-op'],
        before: { token_auth_key: 'SECRET' },
        after: { token_auth_key: 'SECRET' },
      },
    },
  ],
});

test('plan-summary prints only addresses, actions and count', () => {
  const result = run(['bunny', 'plan-summary', 'tfplan'], {
    STUB_SHOW_JSON: plan,
    GITHUB_ACTIONS: 'true',
  });
  assert.equal(result.status, 0, result.all);
  assert.equal(
    result.stdout,
    'update module.bunny.bunnynet_stream_library.media\nchanges: 1\n',
  );
  assert.doesNotMatch(result.all, /SECRET/);
});

test('plan-summary joins replace actions and counts zero', () => {
  const replace = JSON.stringify({
    resource_changes: [
      { address: 'a.b', change: { actions: ['delete', 'create'] } },
    ],
  });
  assert.equal(
    run(['gcp', 'plan-summary', 'p'], { STUB_SHOW_JSON: replace }).stdout,
    'delete,create a.b\nchanges: 1\n',
  );
  const none = JSON.stringify({ format_version: '1.2' });
  assert.equal(
    run(['gcp', 'plan-summary', 'p'], { STUB_SHOW_JSON: none }).stdout,
    'changes: 0\n',
  );
});

test('plan-summary hides show errors', () => {
  const result = run(['bunny', 'plan-summary', 'tfplan'], {
    STUB_SHOW_FAIL: '1',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.all, /SECRET/);
  assert.match(result.stderr, /plan-summary: could not read plan \(exit 1\)/);
});

test('plan-summary needs a plan file', () => {
  assert.equal(run(['gcp', 'plan-summary']).status, 64);
});

// The UK location check (tf-location-check.sh) on every plan

const outside = JSON.stringify({
  resource_changes: [
    {
      address: 'module.bunny.bunnynet_storage_zone.images',
      mode: 'managed',
      type: 'bunnynet_storage_zone',
      change: {
        actions: ['create'],
        after: { region: 'NY', password: 'SECRET' },
        after_sensitive: { password: true },
      },
    },
  ],
});

test('plan saves to a scratch file when given none, checks it, then removes it', () => {
  const result = run(['gcp', 'plan', '-input=false']);
  const call = tofuCall(result);
  const out = call.argv.at(-1);
  assert.match(out, /^-out=.*\/tfplan$/);
  assert.deepEqual(call.argv.slice(1, -1), ['plan', '-input=false']);
  assert.match(result.stderr, /location-check: ok \(0 created or updated\)/);
  assert.ok(!existsSync(dirname(out.slice('-out='.length))));
});

test("plan keeps tofu's exit code and the caller's plan file when the check passes", () => {
  for (const args of [['-out=x'], ['-out', 'x']]) {
    const result = run(['gcp', 'plan', '-detailed-exitcode', ...args], {
      STUB_PLAN_EXIT: '2',
    });
    assert.equal(result.status, 2, result.all);
    const call = JSON.parse(result.stdout.trim());
    assert.deepEqual(call.argv.slice(1), [
      'plan',
      '-detailed-exitcode',
      ...args,
    ]);
    assert.match(result.stderr, /location-check: ok/);
  }
});

// Every root tf.sh plans today is under live/dev, so plans warn; blocking outside dev is
// tf-location-check.test.mjs's (tf.sh passes it the root's environment from its path).
test("in dev, a plan outside the UK warns in the log and step summary and keeps tofu's exit code", () => {
  for (const root of ['gcp', 'bunny', 'bootstrap']) {
    const summary = join(stubs, `summary-${root}.md`);
    writeFileSync(summary, '');
    const result = run([root, 'plan', '-detailed-exitcode', '-out=x'], {
      STUB_PLAN_EXIT: '2',
      STUB_SHOW_JSON: outside,
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, 2, root);
    assert.match(
      result.stderr,
      /location-check: module\.bunny\.bunnynet_storage_zone\.images: region=NY\nlocation-check: WARNING: 1 outside the UK \(dev: /,
    );
    const written = readFileSync(summary, 'utf8');
    assert.match(written, new RegExp(`UK location check \\(${root}, dev\\)`));
    assert.match(written, /images: region=NY/);
    assert.doesNotMatch(result.all + written, /SECRET/);
  }
});

test('a plan inside the UK writes nothing to the step summary', () => {
  const summary = join(stubs, 'summary-ok.md');
  writeFileSync(summary, '');
  const result = run(['gcp', 'plan'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.status, 0, result.all);
  assert.equal(readFileSync(summary, 'utf8'), '');
});

test("a failed plan isn't checked and keeps its exit code", () => {
  const result = run(['gcp', 'plan'], {
    STUB_PLAN_EXIT: '1',
    STUB_SHOW_JSON: outside,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /location-check/);
});

test('location-check checks a saved plan, bunny included, warns in dev and hides show errors', () => {
  assert.equal(
    run(['bunny', 'location-check', 'tfplan'], { STUB_SHOW_JSON: plan }).stdout,
    'location-check: ok (0 created or updated)\n',
  );
  const bad = run(['bunny', 'location-check', 'tfplan'], {
    STUB_SHOW_JSON: outside,
  });
  assert.equal(bad.status, 0);
  assert.match(bad.stdout, /WARNING: 1 outside the UK/);
  assert.doesNotMatch(bad.all, /SECRET/);
  const failed = run(['bunny', 'location-check', 'tfplan'], {
    STUB_SHOW_FAIL: '1',
  });
  assert.equal(failed.status, 0);
  assert.doesNotMatch(failed.all, /SECRET/);
  assert.match(
    failed.all,
    /location-check: WARNING: could not read plan \(exit 1; dev: /,
  );
  assert.equal(run(['gcp', 'location-check']).status, 64);
});

test("location-check reads the root's provider schema, and fails closed without it", () => {
  // A dynamic block on a Google resource: only the schema says whether it may hold a location.
  const unknown = JSON.stringify({
    resource_changes: [
      {
        address: 'google_sql_database_instance.db',
        mode: 'managed',
        type: 'google_sql_database_instance',
        change: {
          actions: ['create'],
          after: { region: 'europe-west2' },
          after_unknown: { settings: [{ backup_configuration: true }] },
          after_sensitive: {},
        },
      },
    ],
  });
  const schema = (backup) =>
    JSON.stringify({
      provider_schemas: {
        'registry.opentofu.org/hashicorp/google': {
          resource_schemas: {
            google_sql_database_instance: {
              block: {
                attributes: { region: { type: 'string' } },
                block_types: {
                  settings: {
                    nesting_mode: 'list',
                    block: {
                      block_types: {
                        backup_configuration: {
                          nesting_mode: 'list',
                          block: { attributes: backup },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  const check = (env) =>
    run(['gcp', 'location-check', 'tfplan'], {
      STUB_SHOW_JSON: unknown,
      ...env,
    });
  assert.equal(
    check({ STUB_SCHEMA_JSON: schema({ enabled: { type: 'bool' } }) }).stdout,
    'location-check: ok (1 created or updated)\n',
  );
  assert.match(
    check({ STUB_SCHEMA_JSON: schema({ location: { type: 'string' } }) })
      .stdout,
    /db: settings\[0\]\.backup_configuration=\(known after apply\)\n.*WARNING: 1 outside the UK/,
  );
  const missing = check({});
  assert.match(missing.stdout, /no provider schema to rule out a location/);
  assert.doesNotMatch(missing.all, /SECRET/);
});

// bunny-mask

test('bunny-mask refused outside CI', () => {
  const result = run(['bunny-mask', 'secrets'], {
    STUB_SECRETS: 'bunny-account-api-key',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /add-mask/);
});

test('bunny-mask secrets', () => {
  const result = run(['bunny-mask', 'secrets'], {
    GITHUB_ACTIONS: 'true',
    STUB_SECRETS:
      'bunny-account-api-key\\nclerk-secret-key\\nbunny-stream-api-key',
  });
  assert.equal(result.status, 0, result.all);
  assert.equal(
    result.stdout,
    '::add-mask::stub-bunny-account-api-key\n::add-mask::stub-bunny-stream-api-key\n',
  );
  assert.equal(result.stderr, '');
});

const resource = (type, values) => ({
  address: `module.bunny.${type}.media`,
  type,
  values,
});
const state = JSON.stringify({
  values: {
    root_module: {
      child_modules: [
        {
          resources: [
            resource('bunnynet_stream_library', {
              api_key: 'k1',
              api_key_readonly: 'k2',
              name: 'not-a-key',
            }),
            resource('bunnynet_storage_zone', {
              password: 'p1\np1-second-line',
              password_readonly: 'p2',
            }),
            resource('bunnynet_pullzone', {
              token_auth_key: 't1',
              name: 'also-not',
            }),
            // D52: the Stream pull zone, read as a data source (key not marked sensitive).
            {
              address: 'module.bunny.data.bunnynet_pullzone.stream',
              mode: 'data',
              type: 'bunnynet_pullzone',
              values: { token_auth_key: 't2', name: 'vz-not-a-key' },
            },
            resource('google_secret_manager_secret', { secret_id: 'bunny-x' }),
          ],
        },
      ],
    },
  },
});

test('bunny-mask state', () => {
  const result = run(['bunny-mask', 'state'], {
    GITHUB_ACTIONS: 'true',
    STUB_SHOW_JSON: state,
  });
  assert.equal(result.status, 0, result.all);
  assert.deepEqual(result.stdout.split('\n').filter(Boolean).sort(), [
    '::add-mask::k1',
    '::add-mask::k2',
    '::add-mask::p1',
    '::add-mask::p1-second-line',
    '::add-mask::p2',
    '::add-mask::t1',
    '::add-mask::t2',
  ]);
  assert.equal(result.stderr, '');
});

test('bunny-mask state, no state yet', () => {
  for (const json of [
    JSON.stringify({ format_version: '1.0', values: {} }),
    JSON.stringify({ format_version: '1.0' }),
  ]) {
    const result = run(['bunny-mask', 'state'], {
      GITHUB_ACTIONS: 'true',
      STUB_SHOW_JSON: json,
    });
    assert.equal(result.status, 0, result.all);
    assert.equal(result.all, '');
  }
});

test('bunny-mask errors stay quiet', () => {
  const result = run(['bunny-mask', 'state'], {
    GITHUB_ACTIONS: 'true',
    STUB_SHOW_FAIL: '1',
  });
  assert.equal(result.status, 1);
  assert.equal(result.all, 'bunny-mask: failed (state)\n');
});

test('bunny-mask needs secrets or state', () => {
  assert.equal(
    run(['bunny-mask', 'other'], { GITHUB_ACTIONS: 'true' }).status,
    64,
  );
});

// stripe-mask

test('stripe-mask refused outside CI', () => {
  const result = run(['stripe-mask']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /add-mask/);
});

test('stripe-mask masks the Stripe key, read as the job', () => {
  const result = run(['stripe-mask'], { GITHUB_ACTIONS: 'true' });
  assert.equal(result.status, 0, result.all);
  assert.equal(result.stdout, '::add-mask::stub-stripe-api-key\n');
  assert.equal(result.stderr, '');
  const access = result.gcloudCalls.find((c) => c[0] === 'secrets');
  assert.ok(access.includes('--secret=stripe-api-key'), JSON.stringify(access));
});

test('stripe-mask takes no arguments', () => {
  assert.equal(
    run(['stripe-mask', 'x'], { GITHUB_ACTIONS: 'true' }).status,
    64,
  );
});

// bunny-cli

test('bunny-cli passes key to one process', () => {
  const result = run(['bunny-cli', 'api', 'GET', '/videolibrary']);
  assert.equal(result.status, 0, result.all);
  assert.equal(result.stdout, 'stub-bunny-account-api-key');
  const access = result.gcloudCalls.find((c) => c[0] === 'secrets');
  assert.ok(
    access.includes(`--impersonate-service-account=${tfBunny}`),
    JSON.stringify(access),
  );

  const self = run(['bunny-cli', 'api'], { TF_SH_IDENTITY: 'self' });
  assert.equal(self.stdout, 'stub-bunny-account-api-key');
  const selfAccess = self.gcloudCalls.find((c) => c[0] === 'secrets');
  assert.ok(
    !selfAccess.some((a) => a.startsWith('--impersonate-service-account')),
  );
});
