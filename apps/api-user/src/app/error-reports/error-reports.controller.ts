import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Module,
  Post,
  Req,
} from '@nestjs/common';
import { AvailableWithoutDatabase } from '@heisreal/database';
import { canonicalIp, ProblemException } from '@heisreal/http';
import {
  currentEvent,
  type ErrorReportKind,
  writeErrorReport,
} from '@heisreal/logging/event';
import { NoRoleRequired } from '@heisreal/roles';
import type { Request } from 'express';

/** A UUID v7, as the browser makes them (LG-1b A). */
const REFERENCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A page's path: no query or fragment (a query can hold search words). */
const ROUTE = /^\/[^?#\s]{0,299}$/;
const KINDS: ReadonlySet<string> = new Set<ErrorReportKind>([
  'browser_crash',
  'no_answer',
]);
const FIELDS: ReadonlySet<string> = new Set(['reference', 'route', 'kind']);

const invalid = (pointer: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, message }],
  );

/** The contract's `ErrorReport`: `{ reference, route, kind }`, nothing else. */
function parseReport(body: unknown): {
  reference: string;
  route: string;
  kind: ErrorReportKind;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'a JSON object');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !FIELDS.has(k));
  if (unknown) throw invalid(`/${unknown}`, 'not a field of this report');
  const { reference, route, kind } = b;
  if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
    throw invalid('/reference', 'a UUID v7');
  }
  if (typeof route !== 'string' || !ROUTE.test(route)) {
    throw invalid('/route', "the page's path");
  }
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw invalid('/kind', 'browser_crash or no_answer');
  }
  return { reference, route, kind: kind as ErrorReportKind };
}

/**
 * `POST /v1/error-reports` (LG-1c, LG-9a; Joel 22–24 Nov 2026): the browser's small report of a
 * failure our servers couldn't see, a crash in our JavaScript or a call that got no answer. It
 * writes one `event: "error_report"` line with the person's reference, and stores nothing,
 * so it answers while the database is restarting too.
 * Anyone may send one, signed in or not; it's rate-limited per address (`errorReports`). Server
 * errors are never reported this way: the servers log those themselves.
 */
@NoRoleRequired(
  'The browser reports its own crashes and unanswered calls, signed in or not; ids only',
)
@AvailableWithoutDatabase()
@Controller('v1/error-reports')
export class ErrorReportsController {
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  sendErrorReport(@Req() req: Request, @Body() body: unknown): void {
    const report = parseReport(body);
    currentEvent()?.set({ action: 'error_report.send' });
    writeErrorReport({
      service: currentEvent()?.service ?? 'api-user',
      ...report,
      client: {
        ip: canonicalIp(req.ip) ?? req.ip,
        userAgent: req.headers['user-agent'],
      },
    });
  }
}

@Module({ controllers: [ErrorReportsController] })
export class ErrorReportsModule {}
