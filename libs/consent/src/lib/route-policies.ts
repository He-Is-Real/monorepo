import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { type ConsentPolicy, resolveConsentPolicy } from './consent.decorators';

export interface RoutePolicy {
  /** e.g. `POST /v1/account/consents` */
  route: string;
  /** `Controller.method` */
  handler: string;
  policy?: ConsentPolicy;
  /** Why the route is misconfigured (no decorator, two decorators, a missing story param). */
  problem?: string;
}

/** A one-line summary per route, for the route-listing tests and the startup error. */
export function describeRoutePolicy(r: RoutePolicy): string {
  if (r.problem) return `${r.route} (${r.handler}): ${r.problem}`;
  const p = r.policy as ConsentPolicy;
  if (p.kind === 'none') return `${r.route}: no consent required (${p.reason})`;
  return `${r.route}: requires ${p.requirement.subject} consent [${p.requirement.types.join(', ')}]`;
}

const joinPath = (...parts: (string | string[] | undefined)[]) => {
  const segments = parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return `/${segments.join('/')}`;
};

/**
 * Every HTTP route the application registers, with its consent policy (D21). Reads the same
 * metadata Nest's router uses, so a route can't be missed.
 */
export function listRoutePolicies(
  discovery: DiscoveryService,
  scanner = new MetadataScanner(),
): RoutePolicy[] {
  const routes: RoutePolicy[] = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as
      (new (...args: never[]) => object) | undefined;
    if (!controller) continue;
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as
      string | string[] | undefined;
    const prototype = controller.prototype as Record<string, object>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined) continue; // not a route handler
      const paths = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      for (const path of Array.isArray(paths) ? paths : [paths]) {
        const route = `${RequestMethod[method]} ${joinPath(prefix, path)}`;
        const resolved = resolveConsentPolicy(handler, controller);
        const entry: RoutePolicy = {
          route,
          handler: `${controller.name}.${name}`,
        };
        if (!resolved.ok) entry.problem = resolved.problem;
        else {
          entry.policy = resolved.policy;
          const p = resolved.policy;
          if (p.kind === 'requires' && p.requirement.subject === 'submitter') {
            const param = p.requirement.storyParam ?? 'id';
            if (!route.split('/').includes(`:${param}`)) {
              entry.problem = `checks the submitter of story :${param}, but the route has no such parameter`;
            }
          }
        }
        routes.push(entry);
      }
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}
