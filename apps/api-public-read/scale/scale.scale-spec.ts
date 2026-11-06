import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ALL_STORIES_LIST_SQL } from '@heisreal/database';
import {
  rows,
  run,
  surrealTestLogin,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { FAVOURITES_SQL } from '@heisreal/story-cards';
import { inject } from 'vitest';
import { Surreal } from 'surrealdb';
import { startPublicRead } from '../integration/app';
import { COMMON, FAN_HEARTS, loadDataset, RARE } from './dataset';
import type { ScaleState } from './global-setup';

/**
 * The local scale test (database review 2, B2; R12): LOCAL ONLY, never GCP or Bunny, and not in
 * CI. A SurrealDB (the cluster's version, RocksDB) holds SCALE_STORIES stories (default 50,000)
 * with a lot of history: sent back and resubmitted, hidden and shown again by a moderator,
 * approved then withdrawn, rejected, drafts. Videos, audio and pictures are storyFile rows the
 * stories point at. One person has 5,000 hearts and 2,000 others 10 each (dataset.ts).
 *
 * The data is loaded once through the real write path and kept on a Docker volume
 * (global-setup.ts): a re-run starts in seconds; a change to the schema or dataset.ts loads
 * afresh. SCALE_FRESH=1 forces a fresh load.
 *
 * Then it times what the public site asks, through api-public-read's real controllers on its
 * read-only login (the answer cache skipped): browse pages newest and oldest first and deep in
 * the list, a theme's list (a popular and a rare theme), a format's list, related stories,
 * search (a common and a rare word, theme names), and a story page. And the favourites list
 * (api-user's query, in the person's own session) with and without the favourite_unique index,
 * the super admins' list of every story (api-admin's query), and a theme rename. Each read is
 * run once to warm up, then RUNS times; the table prints the median and the slowest. The test
 * leaves the data as it found it (renames and the index are put back).
 *
 * Re-run: `pnpm nx run api-public-read:scale-test` (SCALE_STORIES=5000 for a quick run).
 */
const STORIES = Number(process.env['SCALE_STORIES'] ?? 50_000);
const RUNS = 5;
/** Where the counts and the timings table go (vitest hides a passing test's console). */
const OUT =
  process.env['SCALE_OUT'] ?? join(tmpdir(), 'heisreal-scale-results.md');
const report = (line: string) => {
  appendFileSync(OUT, `${line}\n`);
  process.stderr.write(`${line}\n`);
};

/** The kept dataset, or a fresh load of it (then kept). */
async function openDataset(): Promise<TestDatabase> {
  const file = inject('scaleStateFile');
  const state = JSON.parse(readFileSync(file, 'utf8')) as ScaleState;
  if (state.db) {
    report('Reusing the loaded dataset');
    return TestDatabase.restore(state.db);
  }
  if (state.loading) {
    // A load that didn't finish: its namespace goes.
    const login = surrealTestLogin();
    const root = new Surreal();
    await root.connect(login.url, {
      authentication: { username: login.user, password: login.pass },
    });
    await root.query(`REMOVE NAMESPACE IF EXISTS ${state.loading}`).collect();
    await root.close();
  }
  const start = performance.now();
  const t = await TestDatabase.create();
  writeFileSync(file, JSON.stringify({ ...state, loading: t.namespace }), {
    mode: 0o600,
  });
  await loadDataset(t, STORIES, report);
  writeFileSync(
    file,
    JSON.stringify({ rootPassword: state.rootPassword, db: t.saved() }),
    { mode: 0o600 },
  );
  report(`Loaded in ${Math.round((performance.now() - start) / 1000)} s`);
  return t;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe(`scale: ${STORIES} stories`, () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;
  let passTime: (ms: number) => void;
  let fan: Surreal;
  const results: {
    what: string;
    median: number;
    max: number;
    note?: string;
  }[] = [];
  let publicIds: string[] = [];

  /** Runs `fn` once to warm up, then RUNS times; records the median and slowest in ms. */
  async function time(what: string, fn: () => Promise<unknown>, note?: string) {
    await fn();
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      await fn();
      ms.push(performance.now() - start);
    }
    results.push({
      what,
      median: Math.round(median(ms)),
      max: Math.round(Math.max(...ms)),
      note,
    });
  }

  /** A public GET, past the answer cache; answers the JSON. */
  async function get(path: string) {
    passTime(61_000);
    const res = await fetch(`${url}${path}`);
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as {
      data?: unknown[];
      nextCursor?: string | null;
    };
  }

  /** The cursor `pages` pages into a list. */
  async function cursorAt(path: string, pages: number) {
    let cursor: string | null | undefined;
    for (let i = 0; i < pages; i++) {
      const page = await get(
        `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return cursor;
  }

  beforeAll(async () => {
    writeFileSync(OUT, '');
    t = await openDataset();
    migrator = await t.migrator();
    fan = await t.person('user_fan');
    publicIds = await rows<string>(
      migrator,
      `SELECT VALUE record::id(id) FROM story WHERE currentStatus.status = 'approved' ORDER BY id`,
    );
    ({ app, url, passTime } = await startPublicRead(t));
    const [counts] = await rows(
      migrator,
      `RETURN {
         stories: count(SELECT id FROM story),
         public: count(SELECT id FROM story WHERE currentStatus.status = 'approved'),
         statusEntries: count(SELECT id FROM storyStatusLog),
         files: count(SELECT id FROM storyFile),
         hearts: count(SELECT id FROM favourite)
       }`,
    );
    report(`Data: ${JSON.stringify(counts)}`);
  });
  afterAll(async () => {
    await app?.close();
    // Not t.close(): that removes the namespace, and the dataset is kept for the next run.
    await t?.closeConnections();
  });

  it('times the public lists, search, the story page and favourites', async () => {
    await time('browse: newest first, page 1', () =>
      get('/v1/stories?limit=20'),
    );
    const deep = await cursorAt('/v1/stories?limit=20', 50);
    if (deep)
      await time('browse: newest first, page 51 (cursor)', () =>
        get(`/v1/stories?limit=20&cursor=${encodeURIComponent(deep)}`),
      );
    await time('browse: oldest first, page 1', () =>
      get('/v1/stories?limit=20&sort=oldest'),
    );
    await time('theme list: popular theme (t0_0), page 1', () =>
      get('/v1/stories?limit=20&theme=t0_0'),
    );
    await time('theme list: rare theme (t7_7), page 1', () =>
      get('/v1/stories?limit=20&theme=t7_7'),
    );
    await time('format list: audio, page 1', () =>
      get('/v1/stories?limit=20&format=audio'),
    );
    await time(`search: common word ("${COMMON}"), relevance`, () =>
      get(`/v1/stories?limit=20&q=${COMMON}&sort=relevance`),
    );
    await time(`search: common word ("${COMMON}"), newest first`, () =>
      get(`/v1/stories?limit=20&q=${COMMON}`),
    );
    await time(`search: rare word ("${RARE}"), relevance`, () =>
      get(`/v1/stories?limit=20&q=${RARE}&sort=relevance`),
    );
    // Theme names are searched too (Joel, 2026-11-06): t0_0 is "Topicaa", t7_7 "Topichh".
    await time('search: popular theme name ("topicaa"), relevance', () =>
      get('/v1/stories?limit=20&q=topicaa&sort=relevance'),
    );
    await time('search: rare theme name ("topichh"), relevance', () =>
      get('/v1/stories?limit=20&q=topichh&sort=relevance'),
    );
    // Renaming a theme rewrites the search words of the published stories that carry it, in the
    // same write (api-admin's login, as the admin themes page saves it). Timed once each way.
    const admin = await t.service('api_admin');
    const [carrying] = await rows<number>(
      migrator,
      `RETURN count(SELECT id FROM story WHERE themeIds CONTAINS 't0_0' AND currentStatus.status = 'approved')`,
    );
    for (const [theme, to, label] of [
      ['t0_0', 'Topicrenamed', `popular theme (${carrying} published stories)`],
      ['t7_7', 'Topicrare', 'rare theme'],
    ] as const) {
      const start = performance.now();
      await run(admin, `UPDATE type::record('theme', $theme) SET name = $to`, {
        theme,
        to,
      });
      results.push({
        what: `theme rename: ${label}`,
        median: Math.round(performance.now() - start),
        max: Math.round(performance.now() - start),
      });
    }
    await time('search: renamed theme name ("topicrenamed"), relevance', () =>
      get('/v1/stories?limit=20&q=topicrenamed&sort=relevance'),
    );
    // Put the names back, so the kept dataset is as it was.
    await run(
      admin,
      `UPDATE theme:t0_0 SET name = 'Topicaa'; UPDATE theme:t7_7 SET name = 'Topichh';`,
    );
    // The super admins' list of every story (R15; api-admin's own query and login), newest
    // created first: page 1 and 50 pages in.
    const allStories = (after?: [string, string]) =>
      run(admin, ALL_STORIES_LIST_SQL, { after, take: 21 });
    await time('super admins: every story, page 1', () => allStories());
    let after: [string, string] | undefined;
    for (let i = 0; i < 50; i++) {
      const page = (await allStories(after)).at(-1) as {
        id: string;
        createdAt: string;
      }[];
      const last = page[19];
      after = [last.createdAt, last.id];
    }
    await time('super admins: every story, page 51', () => allStories(after));
    const slug = publicIds[Math.floor(publicIds.length / 2)].replace('_', '-');
    await time('story page (by slug)', () => get(`/v1/stories/${slug}`));
    await time('related stories (story page sidebar)', () =>
      get(`/v1/stories/${slug}/related`),
    );

    const favourites = (after?: string) =>
      run(fan, FAVOURITES_SQL, {
        after,
        take: 21,
        show: 20,
      });
    const lastId = async (pages: number) => {
      let after: string | undefined;
      for (let i = 0; i < pages; i++) {
        const out = (await favourites(after)).at(-1) as {
          hearts: { id: string }[];
        };
        after = out.hearts[19]?.id;
      }
      return after;
    };
    await time(`favourites: ${FAN_HEARTS} hearts, page 1`, () => favourites());
    const deepHeart = await lastId(50);
    await time(`favourites: ${FAN_HEARTS} hearts, page 51`, () =>
      favourites(deepHeart),
    );
    await run(migrator, 'REMOVE INDEX favourite_unique ON favourite');
    await time(
      `favourites without favourite_unique: page 1`,
      () => favourites(),
      'index removed',
    );
    await time(
      `favourites without favourite_unique: page 51`,
      () => favourites(deepHeart),
      'index removed',
    );
    await run(
      migrator,
      'DEFINE INDEX favourite_unique ON favourite FIELDS person, story UNIQUE',
    );

    report(
      [
        `| What (${STORIES} stories) | Median ms | Slowest ms |`,
        '| --- | ---: | ---: |',
        ...results.map((r) => `| ${r.what} | ${r.median} | ${r.max} |`),
      ].join('\n'),
    );
    expect(results.length).toBeGreaterThan(0);
  });
});
