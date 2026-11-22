/**
 * `@heisreal/http/rate-limits`: the limits table and the sliding-window counter without NestJS,
 * for web's proxy (apps/web/src/proxy.ts). The APIs import them from `@heisreal/http`.
 */
export * from './lib/rate-limit/limits';
export * from './lib/rate-limit/sliding-window';
export { canonicalIp } from './lib/ip';
