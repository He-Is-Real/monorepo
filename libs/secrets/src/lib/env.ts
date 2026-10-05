/**
 * Reads a required environment variable, failing fast at startup with a clear
 * message rather than at the first request that needs it.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
