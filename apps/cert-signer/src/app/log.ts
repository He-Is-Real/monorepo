/**
 * One JSON line per event on stdout: Cloud Run turns it into a structured log entry
 * (`jsonPayload.step`), which the log-based metrics in infra/terraform/modules/gcp/worker_identity.tf
 * count. Names and outcomes only: never a certificate, key or signature.
 */
export function log(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  entry: Record<string, string>,
): void {
  console.log(JSON.stringify({ severity, ...entry }));
}
