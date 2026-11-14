import { Logger } from '@nestjs/common';
import { createLog, formatLogEntry, minimumSeverity } from './index';
import { JsonLogger } from './nest';

/** Every line written to stdout and stderr while `run` runs, parsed. */
function written(run: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const capture = (chunk: unknown) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const error = vi.spyOn(console, 'error').mockImplementation(capture);
  try {
    run();
  } finally {
    out.mockRestore();
    err.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  delete process.env['LOG_LEVEL'];
  Logger.overrideLogger(new JsonLogger());
});

describe('the shared log line', () => {
  it('is one JSON object with severity, message, an ISO UTC timestamp, then context', () => {
    const line = formatLogEntry(
      'WARNING',
      'renewal failed',
      { step: 'identity_renewal_failed', severity: 'DEBUG' },
      new Date(Date.UTC(2026, 10, 14, 12, 0, 0)),
    );
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      severity: 'WARNING',
      message: 'renewal failed',
      timestamp: '2026-11-14T12:00:00.000Z',
      step: 'identity_renewal_failed',
    });
  });

  it('writes only what LOG_LEVEL allows, INFO by default', () => {
    expect(minimumSeverity({})).toBe('INFO');
    expect(minimumSeverity({ LOG_LEVEL: 'nonsense' })).toBe('INFO');
    const log = createLog({ job: 'housekeeping' });
    const quiet = () => {
      log.debug('hidden');
      log.info('shown');
    };
    expect(written(quiet).map((l) => [l['severity'], l['job']])).toEqual([
      ['INFO', 'housekeeping'],
    ]);
    process.env['LOG_LEVEL'] = 'debug';
    expect(written(quiet).map((l) => l['severity'])).toEqual(['DEBUG', 'INFO']);
    process.env['LOG_LEVEL'] = 'ERROR';
    expect(written(quiet)).toEqual([]);
  });
});

describe("Nest's logger", () => {
  it('maps each Nest level to its severity and keeps the Nest context', () => {
    process.env['LOG_LEVEL'] = 'DEBUG';
    Logger.overrideLogger(new JsonLogger());
    const logger = new Logger('StoriesService');
    const lines = written(() => {
      logger.verbose('v');
      logger.debug('d');
      logger.log('l');
      logger.warn('w');
      logger.error('e');
      logger.fatal('f');
    });
    expect(lines.map((l) => [l['severity'], l['message']])).toEqual([
      ['DEBUG', 'v'],
      ['DEBUG', 'd'],
      ['INFO', 'l'],
      ['WARNING', 'w'],
      ['ERROR', 'e'],
      ['CRITICAL', 'f'],
    ]);
    for (const l of lines) {
      expect(l['context']).toBe('StoriesService');
      expect(l['timestamp']).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      expect(l).not.toHaveProperty('level');
    }
  });

  it('leaves out debug and verbose at the default level', () => {
    Logger.overrideLogger(new JsonLogger());
    const logger = new Logger('X');
    const lines = written(() => {
      logger.verbose('v');
      logger.debug('d');
      logger.log('l');
    });
    expect(lines.map((l) => l['severity'])).toEqual(['INFO']);
  });

  it("puts an error's stack in the same entry", () => {
    Logger.overrideLogger(new JsonLogger());
    const lines = written(() =>
      new Logger('Upload').error(new Error('bunny said no')),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      message: 'bunny said no',
      context: 'Upload',
    });
    expect(String(lines[0]?.['stack_trace'])).toContain('Error: bunny said no');
    expect(String(lines[0]?.['stack_trace'])).toContain('logging.spec.ts');
  });
});
