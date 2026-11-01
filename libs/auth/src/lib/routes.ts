import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { type DiscoveryService, MetadataScanner } from '@nestjs/core';

const joinPath = (...parts: (string | string[] | undefined)[]) => {
  const segments = parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return `/${segments.join('/')}`;
};

/** One registered HTTP route: what Nest's router serves, read from the same metadata. */
export interface RegisteredRoute {
  /** e.g. `POST /v1/account/agreements/:agreement` */
  route: string;
  /** `Controller.method` */
  name: string;
  handler: object;
  controller: object;
}

/**
 * Every HTTP route the application registers. Reads the same metadata Nest's router uses, so
 * a route can't be missed. Used by the role check (D1): `ClerkAuthModule` and the apps' routes
 * specs.
 */
export function listRoutes(
  discovery: DiscoveryService,
  scanner = new MetadataScanner(),
): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
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
        routes.push({
          route: `${RequestMethod[method]} ${joinPath(prefix, path)}`,
          name: `${controller.name}.${name}`,
          handler,
          controller,
        });
      }
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}
