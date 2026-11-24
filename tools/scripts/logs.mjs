#!/usr/bin/env node
// `pnpm logs`: reads our JSON log lines (libs/logging) on stdin and prints one short, coloured
// line each, for people reading a local run (docs/logs-runbook.md; logging decision LG-5). The
// services always write plain JSON (writing-logs skill, rule 11); this only reads it.
//
//   pnpm nx serve api-user 2>&1 | pnpm -s logs
//   pnpm -s logs -v < saved.log                     # also every other field, as compact JSON
//   gcloud logging read '…' --format=json | pnpm -s logs   # Google's entries work too
//
// A line that isn't JSON is printed as it came. Colour only on a terminal (and never with
// NO_COLOR set).
import { createInterface } from 'node:readline';

const verbose =
  process.argv.includes('-v') || process.argv.includes('--verbose');
const colour = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const SEVERITY = {
  DEBUG: '90',
  INFO: '36',
  NOTICE: '34',
  WARNING: '33',
  ERROR: '31',
  CRITICAL: '1;31',
};

/** Fields shown in the summary (or always left out), so `-v` doesn't repeat them. */
const SHOWN = new Set([
  'severity',
  'message',
  'timestamp',
  'event',
  'ref',
  'logging.googleapis.com/trace',
  'service',
  'outcome',
  'stack_trace',
]);

/** A Cloud Logging entry (`gcloud logging read --format=json`) as our own line. */
function fromGoogle(entry) {
  if (!entry || typeof entry !== 'object' || !entry.jsonPayload) return entry;
  return {
    severity: entry.severity,
    timestamp: entry.timestamp,
    ...entry.jsonPayload,
  };
}

/** One line of ours, short: time, severity, service, event, message, then ref and outcome. */
export function formatLine(raw, { verbose: all = false } = {}) {
  const line = fromGoogle(raw);
  const severity = String(line.severity ?? 'DEFAULT');
  const time =
    typeof line.timestamp === 'string'
      ? line.timestamp.slice(11, 23)
      : ''.padEnd(12);
  const parts = [
    paint('90', time),
    paint(SEVERITY[severity] ?? '0', severity.padEnd(8)),
  ];
  const service = line.service?.name ?? line.context ?? line.job;
  if (service) parts.push(paint('35', String(service)));
  if (line.event) parts.push(paint('1', String(line.event)));
  parts.push(String(line.message ?? ''));
  const facts = [];
  if (line.outcome) facts.push(`outcome=${line.outcome}`);
  if (line.http?.status_code) facts.push(`status=${line.http.status_code}`);
  if (line.http?.duration_ms !== undefined)
    facts.push(`${line.http.duration_ms}ms`);
  if (line.error?.code) facts.push(`error=${line.error.code}`);
  if (line.ref) facts.push(`ref=${line.ref}`);
  if (facts.length) parts.push(paint('90', facts.join(' ')));
  let out = parts.join(' ');
  if (all) {
    const rest = Object.fromEntries(
      Object.entries(line).filter(([k]) => !SHOWN.has(k)),
    );
    if (Object.keys(rest).length)
      out += `\n    ${paint('90', JSON.stringify(rest))}`;
  }
  if (line.stack_trace) out += `\n${paint('31', String(line.stack_trace))}`;
  return out;
}

function print(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.log(text);
    return;
  }
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    console.log(
      item && typeof item === 'object'
        ? formatLine(item, { verbose })
        : String(item),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // gcloud's --format=json is one array over many lines: gather it, then print it whole.
  let gathering = null;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (text) => {
    if (gathering !== null) gathering.push(text);
    else if (text.trim() === '[') gathering = [text];
    else print(text);
  });
  lines.on('close', () => {
    if (gathering !== null) print(gathering.join('\n'));
  });
  process.stdout.on('error', () => process.exit(0)); // `| head`
}
