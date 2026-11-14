# @heisreal/logging

The one log format every service, job and the media worker writes (Joel, 2026-11-14): one JSON
object per line, everywhere (Google Cloud and a developer's machine).

```json
{
  "severity": "INFO",
  "message": "api-user listening on http://localhost:3002",
  "timestamp": "2026-11-14T12:00:00.000Z",
  "context": "NestApplication"
}
```

- `severity`: Cloud Logging's names, `DEBUG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`.
- `message`, then `timestamp` (ISO 8601, UTC), then context fields (a Nest `context`, a job's
  `step`, counts and ids). An error's stack is in the same entry, `stack_trace`, where Error
  Reporting looks for it.
- `LOG_LEVEL` sets the lowest severity written: `DEBUG`, `INFO` (the default, also for an
  unknown value), `NOTICE`, `WARNING`, `ERROR` or `CRITICAL`, any case. `LOG_LEVEL=DEBUG` adds
  Nest's `debug` and `verbose` lines.
- ERROR and CRITICAL go to stderr, the rest to stdout.

Use:

- `writeLog(severity, message, fields?)` or `createLog({ job: 'x' }).info(...)`: plain code (the
  website's server code, jobs, the media worker). No dependencies.
- `JsonLogger` from `@heisreal/logging/nest`: Nest's `ConsoleLogger` in JSON mode, extended to
  write `severity` and an ISO `timestamp`. The four API services get it through
  `START_UP_OPTIONS` (libs/database); cert-signer passes it to `NestFactory.create`; code that
  isn't a Nest app but uses libraries logging through Nest's `Logger` calls
  `Logger.overrideLogger(new JsonLogger())`. Nest levels: verbose, debug → DEBUG; log → INFO;
  warn → WARNING; error → ERROR; fatal → CRITICAL.

Never log personal data, tokens, keys or story content.
