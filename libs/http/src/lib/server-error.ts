import type { Response } from 'express';

/**
 * Our generic server error (D30): `500`, `application/problem+json`, `no-store`, and a bare
 * `title` and `status`, never the cause. ProblemFilter sends it for any unexpected failure, and
 * the rate limiters send exactly the same for a caller over a limit (RL-5, Joel 2026-11-21), so
 * the two can't be told apart.
 */
export function sendServerError(response: Response): void {
  sendProblem(response, {
    type: 'about:blank',
    title: 'Internal server error',
    status: 500,
  });
}

/** Sends a problem: the one place its status, content type and caching are set. */
export function sendProblem(
  response: Response,
  problem: { status: number } & Record<string, unknown>,
): void {
  response
    .status(problem.status)
    .type('application/problem+json')
    .setHeader('Cache-Control', 'no-store');
  response.send(JSON.stringify(problem));
}
