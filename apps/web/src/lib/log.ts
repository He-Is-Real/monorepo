import { writeLog } from '@heisreal/logging';
import { StoriesUnavailableError } from './public-stories';

/**
 * One structured line in Cloud Logging, in the shared JSON log format (libs/logging)
 * when a page couldn't reach api-public-read and showed its "can't be loaded" message instead.
 * Error Reporting groups it by its type. Only the page and the failure: no request data, no
 * story content. Nothing alerts on it yet (a log-based metric and alert policy would, through
 * OpenTofu).
 */
export function logStoriesUnavailable(
  page: 'home' | 'browse' | 'story',
  err: StoriesUnavailableError,
): void {
  writeLog('ERROR', `${err.message} (${page} page)`, {
    '@type':
      'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    serviceContext: { service: 'web' },
    context: { reportLocation: { functionName: `${page} page` } },
    page,
  });
}

/** For `.catch()`: logs and returns `fallback` when api-public-read is unavailable. */
export const whenUnavailable =
  <T>(page: 'home' | 'browse' | 'story', fallback: T) =>
  (err: unknown): T => {
    if (!(err instanceof StoriesUnavailableError)) throw err;
    logStoriesUnavailable(page, err);
    return fallback;
  };
