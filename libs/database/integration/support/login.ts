import { inject } from 'vitest';

/** The root login of the test SurrealDB, from the global setup (global-setup.ts). */
export interface SurrealTestLogin {
  url: string;
  user: string;
  pass: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    surrealTest: SurrealTestLogin;
  }
}

export function surrealTestLogin(): SurrealTestLogin {
  const login = inject('surrealTest');
  if (!login) throw new Error('No test SurrealDB (global setup did not run)');
  return login;
}
