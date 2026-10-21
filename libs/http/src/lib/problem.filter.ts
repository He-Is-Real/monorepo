import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/** An RFC 9457 problem (`components.yaml#/components/schemas/Problem`). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
}

/** Throw this for a problem with a stable `code` (D30). */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    title: string,
    detail?: string,
  ) {
    super(
      {
        type: 'about:blank',
        title,
        status,
        code,
        ...(detail ? { detail } : {}),
      },
      status,
    );
  }
}

/**
 * Every error as `application/problem+json` (D30). Unknown errors become a bare 500 with no
 * detail: messages are logged, never echoed (they could hold testimony text).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let problem: Problem;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      problem =
        typeof body === 'object' && body && 'type' in body && 'title' in body
          ? (body as Problem)
          : {
              type: 'about:blank',
              title:
                HttpStatus[status]?.replace(/_/g, ' ').toLowerCase() ?? 'error',
              status,
            };
      problem = { ...problem, title: titleCase(problem.title) };
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
      problem = {
        type: 'about:blank',
        title: 'Internal server error',
        status: 500,
      };
    }
    response
      .status(problem.status)
      .type('application/problem+json')
      .setHeader('Cache-Control', 'no-store');
    response.send(JSON.stringify(problem));
  }
}

const titleCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
