import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * A service whose sign-in the database refuses doesn't start (Joel, 2026-11-08): the process
 * exits with code 1 after one structured `database_refused` line (the shared JSON log format),
 * every other line is JSON too, and nothing it prints repeats
 * the server's own text (Nest's start-up error log and Node's unhandled-rejection dump would).
 */
describe('a refused database sign-in at start-up', () => {
  it('exits 1 with exactly one database_refused line and none of the server text', async () => {
    const serverText = 'raw-server-text-7f3a9c';
    const { code, output } = await new Promise<{
      code: number | null;
      output: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [
          '--require',
          '@swc-node/register',
          join(__dirname, 'testing/refused-start.ts'),
          serverText,
        ],
        {
          cwd: join(__dirname, '../..'),
          // FORCE_COLOR is dropped: with NO_COLOR also set, Node prints a plain-text warning that
          // isn't a log line, so the result would depend on the shell (local == CI).
          env: {
            ...process.env,
            FORCE_COLOR: undefined,
            SWC_NODE_PROJECT: 'tsconfig.lib.json',
          },
          timeout: 60_000,
        },
        (err, stdout, stderr) =>
          resolve({
            code: err ? ((err.code as number | undefined) ?? null) : 0,
            output: stdout + stderr,
          }),
      );
    });

    expect(code).toBe(1);
    const lines = output
      .split('\n')
      .filter((l) => l.includes('database_refused'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      severity: 'CRITICAL',
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      code: 'database_refused',
      kind: 'NotAllowed',
      detail: 'Auth',
    });
    for (const line of output.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(output).not.toContain(serverText);
  }, 70_000);
});
