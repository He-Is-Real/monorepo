import { writeLog } from '@heisreal/logging';

/**
 * One line per event in the shared JSON log format (libs/logging): Cloud Run turns it into a
 * structured log entry (`jsonPayload.step`), which the log-based metrics in
 * infra/terraform/modules/gcp/worker_identity.tf count. The message is the entry's own `message`,
 * or its step. Names and outcomes only: never a certificate, key or signature.
 */
export function log(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  entry: Record<string, string> & { step: string },
): void {
  writeLog(severity, entry['message'] ?? entry.step, entry);
}
