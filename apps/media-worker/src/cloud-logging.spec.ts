import { cloudLoggingSink } from './cloud-logging';

/**
 * The worker's lines reach Cloud Logging as Google's own entries, and a send that fails never
 * reaches the job (it is counted and dropped). No real Google: a fake client.
 */
const line = {
  severity: 'ERROR',
  message: 'media.check RETRY error in 12 ms',
  timestamp: '2026-11-24T12:00:00.000Z',
  event: 'job',
  ref: '019ab7c4-0000-7000-8000-000000000001',
  'logging.googleapis.com/trace':
    'projects/heisreal-dev/traces/019ab7c4000070008000000000000001',
  job: { id: 'x' },
};

describe('the Cloud Logging sink', () => {
  it('sends each line as an entry with its severity, time and trace', async () => {
    const sent: unknown[] = [];
    const sink = cloudLoggingSink('heisreal-dev', {
      request: async (options) => void sent.push(options),
    });
    sink.write('ERROR', line);
    await sink.flush();
    expect(sent).toEqual([
      {
        url: 'https://logging.googleapis.com/v2/entries:write',
        method: 'POST',
        data: {
          partialSuccess: true,
          entries: [
            {
              logName: 'projects/heisreal-dev/logs/media-worker',
              resource: expect.objectContaining({ type: 'generic_node' }),
              severity: 'ERROR',
              timestamp: line.timestamp,
              trace: line['logging.googleapis.com/trace'],
              jsonPayload: {
                message: line.message,
                event: 'job',
                ref: line.ref,
                job: { id: 'x' },
              },
            },
          ],
        },
      },
    ]);
  });

  it('counts a failed send without throwing', async () => {
    const sink = cloudLoggingSink('heisreal-dev', {
      request: () => Promise.reject(new Error('offline')),
    });
    expect(() => sink.write('INFO', line)).not.toThrow();
    await sink.flush();
    expect(sink.failed()).toBe(1);
  });
});
