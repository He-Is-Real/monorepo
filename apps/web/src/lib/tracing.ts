import { startTracing } from '@heisreal/logging/tracing';
import { readSecret } from '@heisreal/secrets/read';

/**
 * Starts OpenTelemetry for the website's server (LG-15 D; instrumentation.ts `register`, first):
 * Next's built-in spans and the proxy's event span go to Axiom's traces dataset where OpenTofu set
 * `AXIOM_TRACES_DATASET`, `AXIOM_DOMAIN` and `AXIOM_TOKEN_SECRET` (the token read from Secret
 * Manager in `GCP_PROJECT` at start-up, in the background, and again once a minute while it can't be
 * read). Never stops the server.
 */
export function startWebTracing(): void {
  startTracing({ service: 'web', read: (name) => readSecret(name) });
}
