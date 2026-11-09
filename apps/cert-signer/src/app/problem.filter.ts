import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Every error as an RFC 9457 problem (D30), like the other services. libs/http's filter would
 * bring the database library with it, and this service has no database.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      type: 'about:blank',
      title: 'Internal Server Error',
      status,
    };
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const reply = exception.getResponse();
      body =
        typeof reply === 'object' && reply !== null && 'code' in reply
          ? (reply as Record<string, unknown>)
          : // Nest's own (a malformed JSON body, an unknown route): status and title only.
            { type: 'about:blank', title: exception.message, status };
    }
    res
      .status(status)
      .type('application/problem+json')
      .send(JSON.stringify(body));
  }
}
