import { execFileSync } from 'node:child_process';

export default async function globalTeardown(): Promise<void> {
  const id = (globalThis as Record<string, unknown>)['__SURREAL_CONTAINER__'];
  if (typeof id === 'string') {
    execFileSync('docker', ['rm', '--force', id], { stdio: 'ignore' });
  }
}
