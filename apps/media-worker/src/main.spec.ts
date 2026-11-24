/**
 * The media worker runs off Cloud Run, so nothing tells libs/logging its name: it names itself
 * (LG-10). A start-up failure (here: no settings at all) is logged as the media worker.
 */
it('a start-up failure line carries service.name "media-worker"', async () => {
  for (const name of ['GCP_PROJECT', 'K_SERVICE', 'CLOUD_RUN_JOB']) {
    vi.stubEnv(name, undefined);
  }
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  try {
    await import('./main.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    const line = JSON.parse(String(errors.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      severity: 'ERROR',
      message: 'stopped',
      service: { name: 'media-worker' },
    });
  } finally {
    errors.mockRestore();
    exit.mockRestore();
    vi.unstubAllEnvs();
  }
});
