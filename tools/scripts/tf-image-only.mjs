#!/usr/bin/env node
// Whether a saved gcp plan may apply without the `dev` approval: D120 (Joel, 2026-10-30), dev
// plans that change only image versions apply themselves (tests: tests/tf-image-only.test.mjs).
//
//   tofu show -json plan > plan.json
//   node tools/scripts/tf-image-only.mjs <environment> plan.json
//
// Prints `auto`, then one line per changed resource: `<service> <image@digest>`. Or prints
// `manual: <reason>`. Exit codes: 64 usage, otherwise 0.
//
// `auto` only if all of these hold, so anything unexpected waits for an approval:
//   - the environment is `dev`. Production never applies on its own, whatever the plan says;
//   - the plan applies cleanly (not errored, applyable, nothing deferred);
//   - every resource change is a no-op, or an in-place `update` of a managed
//     google_cloud_run_v2_service or google_cloud_run_v2_job in project heisreal-dev
//     (no create, delete, replace, read, import or move);
//   - in each update, the only changed attributes are its containers' `image`s, each now a digest
//     from our own `apps` repository; any other attribute changes nothing or is one Google
//     computes after every update (etag, generation, revisions, conditions, ...);
//   - at least one image changes.
// Output changes are allowed: they change nothing in the cloud.
import { readFileSync } from 'node:fs';

/** The only environment that may ever apply on its own. Production never does (D120). */
const AUTO_ENVIRONMENT = 'dev';
const PROJECT = 'heisreal-dev';
const TYPES = new Set([
  'google_cloud_run_v2_service',
  'google_cloud_run_v2_job',
]);
// Our own registry only: apps (built from main), never apps-scratch or anyone else's image.
const IMAGE =
  /^europe-west2-docker\.pkg\.dev\/heisreal-dev\/apps\/([a-z0-9-]+)@sha256:[0-9a-f]{64}$/;
// Where the image sits: a service's template.containers[i], a job's template.template.containers[i].
const IMAGE_PATH = {
  google_cloud_run_v2_service: /^template\.0\.containers\.\d+\.image$/,
  google_cloud_run_v2_job: /^template\.0\.template\.0\.containers\.\d+\.image$/,
};
// Top-level attributes Google sets after every update; they can't be configured.
const COMPUTED = new Set([
  'conditions',
  'create_time',
  'creator',
  'delete_time',
  'effective_annotations',
  'effective_labels',
  'etag',
  'execution_count',
  'expire_time',
  'generation',
  'last_modifier',
  'latest_created_execution',
  'latest_created_revision',
  'latest_ready_revision',
  'observed_generation',
  'reconciling',
  'terminal_condition',
  'terraform_labels',
  'traffic_statuses',
  'uid',
  'update_time',
  'uri',
  'urls',
]);

/** Paths (a.b.0.c) where `after` differs from `before`, or becomes unknown. */
function differences(before, after, unknown, path = []) {
  if (unknown === true) return [{ path, unknown: true }];
  const isObject = (v) => v !== null && typeof v === 'object';
  if (
    isObject(before) &&
    isObject(after) &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    if (Array.isArray(before) && before.length !== after.length)
      return [{ path }];
    const keys = new Set([
      ...Object.keys(before),
      ...Object.keys(after),
      ...Object.keys(isObject(unknown) ? unknown : {}),
    ]);
    return [...keys].flatMap((k) =>
      differences(
        before[k],
        after[k],
        isObject(unknown) ? unknown[k] : undefined,
        [...path, k],
      ),
    );
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null)
    ? []
    : [{ path }];
}

/** `{ auto: true, images: [[service, image], ...] }` or `{ auto: false, reason }`. */
export function decide(environment, plan) {
  const manual = (reason) => ({ auto: false, reason });
  if (environment !== AUTO_ENVIRONMENT)
    return manual(
      `only ${AUTO_ENVIRONMENT} applies on its own; ${environment || 'this environment'} always waits for an approval`,
    );
  if (plan?.errored) return manual('the plan errored');
  if (plan?.applyable === false) return manual('the plan is not applyable');
  if ((plan?.deferred_changes ?? []).length)
    return manual('the plan has deferred changes');
  const images = [];
  for (const rc of plan?.resource_changes ?? []) {
    const actions = rc.change?.actions ?? [];
    if (actions.length === 1 && actions[0] === 'no-op') continue;
    const where = rc.address ?? 'a resource';
    if (actions.length !== 1 || actions[0] !== 'update')
      return manual(`${where}: ${actions.join(', ') || 'no action'}`);
    if (rc.mode !== 'managed' || !TYPES.has(rc.type))
      return manual(`${where}: not a Cloud Run service or job`);
    if (rc.change.importing || rc.previous_address)
      return manual(`${where}: imported or moved`);
    const { before, after, after_unknown: unknown } = rc.change;
    if (before?.project !== PROJECT || after?.project !== PROJECT)
      return manual(`${where}: not in ${PROJECT}`);
    let changed = 0;
    for (const d of differences(before, after, unknown)) {
      const path = d.path.join('.');
      if (d.unknown && d.path.length >= 1 && COMPUTED.has(d.path[0])) continue;
      if (!d.unknown && COMPUTED.has(d.path[0])) continue;
      if (d.unknown || !IMAGE_PATH[rc.type].test(path))
        return manual(`${where}: ${path || 'the resource'} changes`);
      const image = d.path.reduce((v, k) => v?.[k], after);
      if (typeof image !== 'string' || !IMAGE.test(image))
        return manual(
          `${where}: the new image isn't a digest from ${PROJECT}'s apps repository`,
        );
      images.push([after.name ?? where, image]);
      changed++;
    }
    if (!changed) return manual(`${where}: an update with no image change`);
  }
  if (!images.length) return manual('no image changes');
  return { auto: true, images };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [environment, file] = process.argv.slice(2);
  if (!environment || !file) {
    process.stderr.write(
      'usage: tf-image-only.mjs <environment> <plan.json>\n',
    );
    process.exit(64);
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log('manual: the plan could not be read');
    process.exit(0);
  }
  const result = decide(environment, plan);
  if (!result.auto) console.log(`manual: ${result.reason}`);
  else
    console.log(
      ['auto', ...result.images.map(([s, i]) => `${s} ${i}`)].join('\n'),
    );
}
