/**
 * The result writer (apps/workflow on Cloud Run): the worker calls it directly, signed in as the
 * media-worker Google account (J5). Cloud Run checks the Google ID token (audience = the writer's
 * URL) and refuses anyone without run.invoker before the request reaches the writer.
 */

const TIMEOUT_MS = 30_000; // a cold start of the writer, then one database transaction

/** Each carries the job's video id; the writer refuses a call naming another video (400). */
export type WriterCall =
  | { route: 'answer'; jobId: string; body: { videoId: string } }
  | { route: 'failed'; jobId: string; body: { videoId: string; code: string } }
  | { route: 'upload-pass'; jobId: string; body: { videoId: string } }
  | {
      route: 'rendered';
      jobId: string;
      body: {
        videoId: string;
        renderVideoId: string;
        picture: string | null;
        sizeBytes: number;
      };
    };

/**
 * The writer's HTTP reply, or why there is none: `unreachable` (network, timeout) or `no_token`
 * (Google wouldn't give us an ID token).
 */
export type WriterReply =
  { status: number; body: unknown } | 'unreachable' | 'no_token';

export type Writer = (call: WriterCall) => Promise<WriterReply>;

export function httpWriter(
  baseUrl: string,
  /** A Google ID token for the writer's URL, as media-worker. */
  idToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): Writer {
  const base = baseUrl.replace(/\/+$/, '');
  return async (call) => {
    let token: string;
    try {
      token = await idToken();
    } catch {
      return 'no_token';
    }
    let res: Response;
    try {
      res = await fetcher(`${base}/v1/media-jobs/${call.jobId}/${call.route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(call.body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return 'unreachable';
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A reply that isn't JSON (Cloud Run's own 403 page, say): only its status counts.
    }
    return { status: res.status, body };
  };
}
