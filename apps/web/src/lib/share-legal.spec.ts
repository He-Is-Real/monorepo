/**
 * @jest-environment node
 */
import { getShareLegal } from './share-legal';

// Codex #118, 4: the privacy document shown beside a form is the one *that version* links, read
// by version, never "the one in force". The stub api-public-read serves one version of each, so
// a form linking another one can only be staged here, at the network edge.

const form = (name: string, dpaVersion: string) => ({
  form: name,
  id: 'v3',
  status: 'published',
  publishedAt: '2026-10-25T12:00:00.000Z',
  dpaVersion,
  textHash: 'a'.repeat(64),
  text: `# The ${name} form`,
  statements:
    name === 'social'
      ? ['share_socials']
      : ['special_category_religious', 'publish'],
  boxes:
    name === 'social'
      ? [{ statement: 'share_socials', label: 'Share it' }]
      : [
          { statement: 'special_category_religious', label: 'Store my story' },
          { statement: 'publish', label: 'Publish it' },
        ],
  statementsHash: 'b'.repeat(64),
  version: 1,
});
const dpa = (id: string) => ({
  current: {
    id,
    kind: 'standard',
    status: 'published',
    materiality: 'material',
    contentHash: 'c'.repeat(64),
    version: 1,
    text: `# Privacy document ${id}`,
  },
  history: [],
});
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

describe('getShareLegal', () => {
  const saved = {
    url: process.env['API_PUBLIC_READ_URL'],
    fetch: global.fetch,
  };
  let fetchMock: jest.Mock;
  beforeEach(() => {
    process.env['API_PUBLIC_READ_URL'] = 'https://api-public-read.example';
    fetchMock = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/v1/legal/forms/testimony')
        return json(form('testimony', 'dpa_old'));
      if (u.pathname === '/v1/legal/forms/social')
        return json(form('social', 'dpa_new'));
      if (u.pathname === '/v1/legal/dpa') {
        const v = u.searchParams.get('version');
        return v ? json(dpa(v)) : json(dpa('dpa_new'));
      }
      return json({}, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    process.env['API_PUBLIC_READ_URL'] = saved.url;
    global.fetch = saved.fetch;
  });

  it('pairs each form with the privacy document its own version links', async () => {
    const legal = await getShareLegal();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain(
      'https://api-public-read.example/v1/legal/dpa?version=dpa_old',
    );
    expect(urls).toContain(
      'https://api-public-read.example/v1/legal/dpa?version=dpa_new',
    );
    expect(urls).not.toContain('https://api-public-read.example/v1/legal/dpa');
    expect(legal.testimony).toMatchObject({
      version: 'v3',
      dpaVersion: 'dpa_old',
    });
    expect(JSON.stringify(legal.testimony?.dpaBlocks)).toContain('dpa_old');
    expect(legal.social).toMatchObject({ dpaVersion: 'dpa_new' });
    // The boxes are the version's structured data (D114).
    expect(legal.testimony?.boxes.map((b) => b.statement)).toEqual([
      'special_category_religious',
      'publish',
    ]);
  });

  it('shows no form whose linked privacy document can’t be read as that version', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/v1/legal/forms/testimony')
        return json(form('testimony', 'dpa_old'));
      if (u.pathname === '/v1/legal/forms/social')
        return json(form('social', 'dpa_old'));
      // Answers with another version than the one asked for.
      if (u.pathname === '/v1/legal/dpa') return json(dpa('dpa_new'));
      return json({}, 404);
    });
    expect(await getShareLegal()).toEqual({ testimony: null, social: null });
  });
});
