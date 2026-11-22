/**
 * What a rate-limited server action gets (RL-5): the proxy (proxy.ts) rewrites a limited POST
 * here. A route handler never runs server actions, so the action doesn't run; this one fails, so
 * Next answers as for any crash (status 500), and the caller's action fails like any other.
 */
export function POST(): never {
  throw new Error('Rate limited');
}
