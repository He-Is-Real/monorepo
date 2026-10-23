import { SURREAL } from '@heisreal/database';
import { Test } from '@nestjs/testing';
import { TagsController, tagProbes } from './tags.controller';

const TAGS = [
  { slug: 'hope', name: 'Hope', category: 'emotion', version: 1 },
  { slug: 'healing', name: 'Healing', category: 'theme', version: 1 },
  { slug: 'doubt', name: 'Doubt', category: 'journey', version: 2 },
];

/** Records each query; answers the tag list, then one probe result per statement. */
function database(inUse: string[]) {
  const sent: { sql: string; vars: Record<string, unknown> | undefined }[] = [];
  return {
    sent,
    db: {
      query: (sql: string, vars?: Record<string, unknown>) => ({
        json: () => ({
          responses: async () => {
            sent.push({ sql, vars });
            if (sent.length === 1) return [{ success: true, result: TAGS }];
            return Object.values(vars ?? {}).map((slug) => ({
              success: true,
              result: inUse.includes(slug as string) ? ['publicStory:x'] : [],
            }));
          },
        }),
      }),
    },
  };
}

describe('TagsController (D63)', () => {
  const list = async (db: unknown) => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TagsController],
      providers: [{ provide: SURREAL, useValue: db }],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${await app.getUrl()}/v1/tags`);
      return (await res.json()) as { data: { slug: string }[] };
    } finally {
      await app.close();
    }
  };

  it('sends one top-level probe per tag, slugs bound, never in the query text', async () => {
    const { db, sent } = database(['healing', 'doubt']);
    const body = await list(db);
    expect(body.data.map((t) => t.slug)).toEqual(['healing', 'doubt']);
    expect(sent).toHaveLength(2);
    const { statements, vars } = tagProbes(TAGS.map((t) => t.slug));
    expect(sent[1]).toEqual({ sql: statements.join(';\n'), vars });
    for (const t of TAGS) expect(sent[1].sql).not.toContain(t.slug);
    // No closure: 3.2.4 iterates the table inside one (Codex, #67).
    expect(sent[1].sql).not.toMatch(/filter|\|\$/);
  });

  it('builds each probe as one indexed lookup, at most one match', () => {
    expect(tagProbes(['a', 'b'])).toEqual({
      statements: [
        'SELECT VALUE id FROM publicStory WHERE tagSlugs CONTAINS $t0 LIMIT 1',
        'SELECT VALUE id FROM publicStory WHERE tagSlugs CONTAINS $t1 LIMIT 1',
      ],
      vars: { t0: 'a', t1: 'b' },
    });
  });

  it('asks nothing more when there are no tags', async () => {
    const sent: string[] = [];
    const db = {
      query: (sql: string) => ({
        json: () => ({
          responses: async () => {
            sent.push(sql);
            return [{ success: true, result: [] }];
          },
        }),
      }),
    };
    expect((await list(db)).data).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});
