import { canonicalIp } from '@heisreal/http';
import type { Request } from 'express';

/**
 * The IP address a request came from, as the block list keeps it (G21 D, Joel 2026-11-11):
 * recorded on a story's "sent" entry (`storyStatusLog.senderIp`, 30 days) and checked against
 * `blockedIp` when a story is sent.
 *
 * api-user runs on Cloud Run with no load balancer in front, so Google's front end is the only
 * proxy: it appends the address it saw the request come from to `X-Forwarded-For`. Anything
 * before that entry was sent by the client itself and can say anything, so the address is the
 * header's LAST entry, the one Google set (docs/how-the-app-works.md). With no header (local
 * runs, tests without one) it is the socket's peer.
 *
 * In the block list's one form (`canonicalIp`); undefined if it isn't an IP address.
 */
export function senderIp(req: Request): string | undefined {
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return canonicalIp(forwarded ?? req.socket?.remoteAddress);
}
