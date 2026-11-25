import { wideEvents } from '@heisreal/http';
import type { RequestHandler } from 'express';
import { ERROR_REPORTS_PATH } from './error-reports/error-reports.controller';

/**
 * api-user's wide event per request (libs/http). The anonymous error-report route's body is
 * never logged, not even on a refusal or a rate limit (coordinator decision, Codex review of
 * #286: an exception to LG-9b, so nobody can write their own text into our logs through it).
 */
export const apiUserWideEvents = (): RequestHandler =>
  wideEvents('api-user', 'request', { bodyNeverLogged: [ERROR_REPORTS_PATH] });
