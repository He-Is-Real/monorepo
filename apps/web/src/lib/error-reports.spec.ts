/**
 * @jest-environment node
 */
import {
  flushErrorReports,
  reportNoAnswer,
  setErrorReportsUrl,
  waitingErrorReports,
} from './error-reports';

// The retries rule (RT-13, Joel, 2026-11-27): a "no answer" report is tried three times at most,
// then dropped. No page is offline long enough in the e2e suite, so it is pinned here, without
// waiting for the 30-second timer (each try is a flush, as when the page is back online).
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

it('drops a report after its third try gets no answer', async () => {
  const tries: string[] = [];
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    tries.push(String(init?.body));
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  setErrorReportsUrl('https://api-user.example');
  reportNoAnswer('01936f2e-0000-7000-8000-000000000001');

  await flushErrorReports();
  await flushErrorReports();
  expect(waitingErrorReports()).toHaveLength(1);
  await flushErrorReports();
  expect(waitingErrorReports()).toHaveLength(0);
  expect(tries).toHaveLength(3);

  await flushErrorReports();
  expect(tries).toHaveLength(3);
});
