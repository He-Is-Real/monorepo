/**
 * NestJS's logger writing the shared JSON format (`@heisreal/logging`): Nest's own
 * `ConsoleLogger` in its JSON mode, extended the documented way so each line carries
 * `severity` (Cloud Logging's name) and an ISO `timestamp` instead of Nest's `level` and epoch
 * milliseconds. Every `Logger` call in a service goes through it once it is the app's logger
 * (`START_UP_OPTIONS` in libs/database) or the static logger (`Logger.overrideLogger`).
 *
 * Nest level → severity: verbose and debug → DEBUG, log → INFO, warn → WARNING, error → ERROR,
 * fatal → CRITICAL. An error's stack goes in `stack_trace`, in the same entry.
 */
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { minimumSeverity, SEVERITIES, type Severity } from './index';

export const NEST_SEVERITY: Record<LogLevel, Severity> = {
  verbose: 'DEBUG',
  debug: 'DEBUG',
  log: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/** The Nest levels written when the lowest severity written is `minimum`. */
export function nestLogLevels(minimum: Severity): LogLevel[] {
  const from = SEVERITIES.indexOf(minimum);
  return (Object.keys(NEST_SEVERITY) as LogLevel[]).filter(
    (level) => SEVERITIES.indexOf(NEST_SEVERITY[level]) >= from,
  );
}

export class JsonLogger extends ConsoleLogger {
  constructor(context?: string) {
    const options = {
      json: true,
      colors: false,
      compact: true,
      flattenParams: true,
      logLevels: nestLogLevels(minimumSeverity()),
    };
    if (context) super(context, options);
    else super(options);
  }

  protected override stringifyJsonLogObject(
    logObject: Record<string, unknown>,
  ): string {
    const { level, timestamp, message, stack, error, ...context } = logObject;
    delete context['pid'];
    const entry: Record<string, unknown> = {
      severity: NEST_SEVERITY[level as LogLevel] ?? 'DEFAULT',
      message,
      timestamp: new Date(timestamp as number).toISOString(),
      ...context,
    };
    if (error && typeof error === 'object') {
      const { stack: errorStack, ...rest } = error as Record<string, unknown>;
      entry['error'] = rest;
      entry['stack_trace'] = typeof stack === 'string' ? stack : errorStack;
    } else if (typeof stack === 'string') {
      entry['stack_trace'] = stack;
    }
    return super.stringifyJsonLogObject(entry);
  }
}
