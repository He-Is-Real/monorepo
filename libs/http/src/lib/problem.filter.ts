import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { DatabaseAvailability } from '@heisreal/database';
import {
  currentEvent,
  type WideEvent,
  writeErrorLine,
} from '@heisreal/logging/event';
import type { Response } from 'express';
import { sendProblem } from './server-error';
import { outcomeForStatus } from './wide-events';

/** An RFC 9457 problem (`components.yaml#/components/schemas/Problem`). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  errors?: FieldError[];
  /** `service_restarting` only: when this copy first saw the database unavailable. */
  restartingSince?: string;
  /** `service_restarting` only: when to try again, also sent as `Retry-After`. */
  retryAfterSeconds?: number;
}

/** A field error in a `400` (`Problem.errors[]`). Never echoes the value that was sent. */
export interface FieldError {
  /** JSON Pointer to the field; for query parameters, `/<name>`. */
  pointer: string;
  code?: string;
  message: string;
}

/** Throw this for a problem with a stable `code` (D30). */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    title: string,
    detail?: string,
    errors?: FieldError[],
  ) {
    super(
      {
        type: 'about:blank',
        title,
        status,
        code,
        ...(detail ? { detail } : {}),
        ...(errors?.length ? { errors } : {}),
      },
      status,
    );
  }
}

/**
 * Every error as `application/problem+json` (D30). Unknown errors become a bare 500 with no
 * detail: messages are logged, never echoed (they could hold testimony text). The database being
 * unreachable (it's restarting: SurrealDB runs on Spot) is `503 service_restarting` with
 * `Retry-After` (docs/how-the-app-works.md, "Database restarts").
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Optional() private readonly database?: DatabaseAvailability) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const event = currentEvent();
    let problem: Problem;
    if (this.database?.noticeFailure(exception)) {
      event?.fail(
        {
          type: 'DatabaseUnavailable',
          code: 'service_restarting',
          retriable: true,
        },
        'restarting',
      );
      const restarting = this.database.restarting();
      problem = {
        type: 'about:blank',
        title: 'Service restarting',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'service_restarting',
        detail:
          'Our compute is currently restarting. Please try again in a few minutes.',
        ...restarting,
      };
      response.setHeader('Retry-After', String(restarting.retryAfterSeconds));
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const title =
        HttpStatus[status]?.replace(/_/g, ' ').toLowerCase() ?? 'error';
      problem =
        typeof body === 'object' && body && 'type' in body && 'title' in body
          ? (body as Problem)
          : (coded(body, status, title) ?? {
              type: 'about:blank',
              title,
              status,
            });
      problem = { ...problem, title: titleCase(problem.title) };
      if (event) recordHttpException(event, exception, problem);
    } else {
      // The immediate error line (Error Reporting reads its stack), then the event's fields.
      writeErrorLine(exception, { ref: event?.ref, traceId: event?.traceId });
      event?.fail({
        type: exception instanceof Error ? exception.name : 'Error',
        retriable: false,
      });
      problem = {
        type: 'about:blank',
        title: 'Internal server error',
        status: 500,
      };
    }
    sendProblem(response, { ...problem });
  }
}

/**
 * An answered refusal or failure on the request's event: its outcome; an input refusal's failed
 * fields and checks (names only, never the values); otherwise `error.type` and our `code`.
 * An `error` already recorded (e.g. why a token was refused) is kept.
 */
function recordHttpException(
  event: WideEvent,
  exception: HttpException,
  problem: Problem,
): void {
  const outcome = outcomeForStatus(problem.status);
  event.setOutcome(outcome, { force: true });
  if (outcome === 'input_refused') {
    const errors = problem.errors ?? [];
    // A refusal without field errors (a refused signature, a picture Bunny wouldn't take) is
    // one failed check: its code.
    event.set({
      input: {
        failed_fields: errors.map((e) => e.pointer.replace(/^\//, '')),
        failed_checks: errors.length
          ? errors.map((e) => e.code ?? 'invalid')
          : [problem.code ?? 'invalid'],
      },
    });
    return;
  }
  if (outcome === 'not_found' || event.get('error') !== undefined) return;
  event.set({
    error: {
      type: exception.name,
      code: problem.code,
      retriable: problem.status >= 500 ? true : undefined,
    },
  });
}

const titleCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Our own Nest exceptions with a stable `code` (`new ForbiddenException({ code, message, … })`,
 * as libs/auth and the services throw them) as problems: `message` becomes `detail`, and `code`,
 * `errors` and any other fields we set (e.g. `requiredRole`) are kept. Only bodies with a `code`:
 * those are written by us, so they hold no request data. Anything else (Nest's own errors, a
 * plain message) gets the bare status title.
 */
function coded(
  body: unknown,
  status: number,
  title: string,
): Problem | undefined {
  if (typeof body !== 'object' || !body) return undefined;
  const { code, message, statusCode, error, ...rest } = body as Record<
    string,
    unknown
  >;
  void statusCode;
  void error;
  if (typeof code !== 'string') return undefined;
  return {
    ...rest,
    type: 'about:blank',
    title,
    status,
    code,
    ...(typeof message === 'string' ? { detail: message } : {}),
  };
}
