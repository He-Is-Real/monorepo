import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  agreeAll,
  createPeople,
  rows,
  run,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { FAVOURITES_SQL } from '@heisreal/story-cards';
import type { Surreal } from 'surrealdb';
import { startPublicRead } from '../integration/app';

/**
 * The local scale test (database review 2, B2; R12): LOCAL ONLY, never GCP or Bunny, and not in
 * CI. A throwaway SurrealDB (the cluster's version, RocksDB) gets SCALE_STORIES stories (default
 * 50,000) with a lot of history: sent back and resubmitted, hidden and shown again by a
 * moderator, approved then withdrawn, rejected, drafts. Videos, audio and pictures are storyFile
 * rows the stories point at. One person has 5,000 hearts and 2,000 others 10 each.
 *
 * Then it times what the public site asks, through api-public-read's real controllers on its
 * read-only login (the answer cache skipped): browse pages newest and oldest first and deep in
 * the list, a theme's list (a popular and a rare theme), a format's list, search (a common and a
 * rare word), and a story page. And the favourites list (api-user's query, in the person's own
 * session), with and without the favourite_unique index. Each is run once to warm up, then
 * RUNS times; the table prints the median and the slowest.
 *
 * Re-run: `pnpm nx run api-public-read:scale-test` (SCALE_STORIES=5000 for a quick run).
 */
const STORIES = Number(process.env['SCALE_STORIES'] ?? 50_000);
const PEOPLE = 2_000;
// Small transactions: 3.2.4 slows down sharply as one transaction grows (500 stories at once:
// 0.3 s a story; 25 at once: 22 ms).
const BATCH = 25;
const RUNS = 5;
const CATEGORIES = 8;
const THEMES_PER_CATEGORY = 8;
const FAN_HEARTS = 5_000;
/** Where the counts and the timings table go (vitest hides a passing test's console). */
const OUT =
  process.env['SCALE_OUT'] ?? join(tmpdir(), 'heisreal-scale-results.md');
const report = (line: string) => {
  appendFileSync(OUT, `${line}\n`);
  process.stderr.write(`${line}\n`);
};

/** The same numbers on every run (mulberry32). */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(20261106);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];

const WORDS = (
  'grace hope prayer church family friend morning night road years mother father brother ' +
  'sister doubt fear peace joy healing hospital work school city village river mountain ' +
  'letter phone song book bible verse quiet storm light window door table kitchen garden ' +
  'heart hands voice name answer question journey change trust forgive love kindness'
).split(' ');
const COMMON = 'faith';
const RARE = 'lighthouse';

/** About `chars` characters of plain words; most stories say "faith", a few "lighthouse". */
function text(chars: number): string {
  const out: string[] = [];
  let length = 0;
  while (length < chars) {
    const r = random();
    const w = r < 0.02 ? COMMON : r < 0.0201 ? RARE : pick(WORDS);
    out.push(w);
    length += w.length + 1;
  }
  return out.join(' ') + '.';
}

const HOUR = 3_600_000;
const START = Date.UTC(2023, 0, 1);
const SPAN = Date.UTC(2026, 10, 1) - START;

type Step = {
  status: string;
  actor: 'person' | 'moderator';
  comment?: string;
};

/** A story's history, from its first submission to its status now (mostly approved). */
function history(): Step[] {
  const p = (status: string): Step => ({ status, actor: 'person' });
  const m = (status: string, comment?: string): Step => ({
    status,
    actor: 'moderator',
    comment,
  });
  const r = random();
  if (r < 0.05) return [];
  if (r < 0.1) return [p('pending')];
  if (r < 0.13) return [p('pending'), m('in_review')];
  if (r < 0.17) return [p('pending'), m('in_review'), m('rejected', 'Sorry')];
  if (r < 0.21)
    return [
      p('pending'),
      m('in_review'),
      m('changes_requested', 'Please shorten it'),
      p('withdrawn'),
    ];
  const steps: Step[] = [p('pending'), m('in_review')];
  if (random() < 0.3)
    steps.push(
      m('changes_requested', 'A small change'),
      p('pending'),
      m('in_review'),
    );
  steps.push(m('approved'));
  const later = random();
  if (later < 0.1) steps.push(m('hidden', 'Checking'), m('approved'));
  else if (later < 0.15) steps.push(p('withdrawn'));
  return steps;
}

const uuid = (i: number) =>
  `5ca1e000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** One story's variables for LOAD_SQL. */
function story(i: number) {
  const id = `sc_${i}`;
  const r = random();
  const format = r < 0.7 ? 'written' : r < 0.9 ? 'video' : 'audio';
  const themes = new Set<string>();
  const count = 1 + Math.floor(random() * 4);
  while (themes.size < count) {
    // Popular themes first: theme t0_0 is in about a third of the stories.
    const n = Math.floor(
      Math.pow(random(), 2.5) * CATEGORIES * THEMES_PER_CATEGORY,
    );
    themes.add(
      `t${Math.floor(n / THEMES_PER_CATEGORY)}_${n % THEMES_PER_CATEGORY}`,
    );
  }
  const steps = history();
  const publishedAt = new Date(START + random() * SPAN);
  const video = uuid(i);
  return {
    id,
    person: `sp_${Math.floor(random() * PEOPLE)}`,
    title: `Story ${i}: ${pick(WORDS)} and ${pick(WORDS)}`,
    description: `How ${pick(WORDS)} led me to ${pick(WORDS)}, ${text(40)}`,
    body: format === 'written' ? text(800 + random() * 2_000) : text(220),
    primaryFormat: format,
    themes: [...themes],
    media:
      format === 'written'
        ? undefined
        : {
            key: video,
            row: {
              format,
              contentType: format === 'video' ? 'video/mp4' : 'audio/mpeg',
              sizeBytes: 1_000_000,
              storyVersion: 1,
              processing: 'ready',
              lengthSeconds: 30 + Math.floor(random() * 600),
              width: format === 'video' ? 1080 : 1280,
              height: format === 'video' ? 1920 : 720,
              thumbnailPath:
                format === 'audio'
                  ? `${video}/thumbnail_0a1b2c3d.jpg`
                  : undefined,
            },
          },
    image:
      random() < 0.3
        ? {
            key: `stories/${id}/${i.toString(16).padStart(32, '0')}.webp`,
            row: {
              format: 'image',
              contentType: 'image/webp',
              sizeBytes: 40_000,
              storyVersion: 1,
              processing: 'ready',
              width: 900,
              height: 1200,
            },
            alt: 'A picture',
          }
        : undefined,
    steps: steps.map((s, k) => ({
      ...s,
      at: new Date(publishedAt.getTime() - (steps.length - 1 - k) * HOUR),
    })),
    publishedAt,
  };
}

/** As dev-seed loads its stories (a system user: the events and checks all run). */
const LOAD_SQL = `
BEGIN TRANSACTION;
FOR $s IN $stories {
  LET $story = type::record('story', $s.id);
  LET $person = type::record('user', $s.person);
  CREATE $story CONTENT {
    submitter: $person, slug: string::replace($s.id, '_', '-'), title: $s.title, description: $s.description,
    body: $s.body, primaryFormat: $s.primaryFormat,
    themeRefs: $s.themes.map(|$t| type::record('theme', $t))
  } RETURN NONE;
  IF $s.media != NONE {
    CREATE type::record('storyFile', $s.media.key) CONTENT object::extend($s.media.row, {
      story: $story, person: $person }) RETURN NONE;
    UPDATE $story SET mediaFile = type::record('storyFile', $s.media.key) RETURN NONE;
  };
  IF $s.image != NONE {
    CREATE type::record('storyFile', $s.image.key) CONTENT object::extend($s.image.row, {
      story: $story, person: $person }) RETURN NONE;
    UPDATE $story SET image = { file: type::record('storyFile', $s.image.key), alt: $s.image.alt }
      RETURN NONE;
  };
  FOR $step IN $s.steps {
    CREATE storyStatusLog CONTENT {
      story: $story, status: $step.status, actor: $step.actor, at: $step.at,
      by: IF $step.actor = 'moderator' { user:sp_moderator },
      comment: $step.comment,
      publishedAt: IF $step.status = 'approved' { $s.publishedAt }
    } RETURN NONE;
  };
};
COMMIT TRANSACTION;`;

/** Hearts on public stories (ULIDs made now, as favourite_rules wants). */
const HEARTS_SQL = `
BEGIN TRANSACTION;
FOR $h IN $hearts {
  CREATE type::record('favourite', rand::ulid()) CONTENT {
    person: type::record('user', $h.person), story: type::record('story', $h.story)
  } RETURN NONE;
};
COMMIT TRANSACTION;`;

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
    const loadStart = performance.now();
    t = await TestDatabase.create();
    migrator = await t.migrator();
    await createPeople(t, { fan: 'user_fan' });
    fan = await t.person('user_fan');
    await agreeAll(fan);
    // The people, the moderator and the themes, agreed to the latest texts and trusted.
    await run(
      migrator,
      `LET $terms = fn::legal::latest('termsOfUseAgreement');
       LET $testimony = fn::legal::latest('testimonyConsent');
       FOR $i IN 0..$people {
         LET $u = type::record('user', 'sp_' + <string> $i);
         CREATE $u CONTENT { termsOfUse: $terms, termsOfUseAgreedAt: time::now(), testimonyConsent: $testimony, testimonyConsentAgreedAt: time::now() } RETURN NONE;
         CREATE type::record('submitterLimits', record::id($u)) SET user = $u, trusted = true RETURN NONE;
       };
       CREATE user:sp_moderator RETURN NONE;
       FOR $c IN 0..$categories {
         CREATE type::record('themeCategory', 'c' + <string> $c) SET name = 'Category ' + <string> $c RETURN NONE;
         FOR $k IN 0..$perCategory {
           CREATE type::record('theme', 't' + <string> $c + '_' + <string> $k) SET
             name = 'Theme ' + <string> $c + '.' + <string> $k,
             category = type::record('themeCategory', 'c' + <string> $c) RETURN NONE;
         };
       };`,
      {
        people: PEOPLE,
        categories: CATEGORIES,
        perCategory: THEMES_PER_CATEGORY,
      },
    );
    report(
      `People and themes: ${Math.round((performance.now() - loadStart) / 1000)} s`,
    );
    for (let from = 0; from < STORIES; from += BATCH) {
      const stories = Array.from(
        { length: Math.min(BATCH, STORIES - from) },
        (_, k) => story(from + k),
      );
      await run(migrator, LOAD_SQL, { stories });
      if ((from + BATCH) % 2_500 === 0)
        report(
          `  ${from + BATCH} stories: ${Math.round((performance.now() - loadStart) / 1000)} s`,
        );
    }
    report(`Stories: ${Math.round((performance.now() - loadStart) / 1000)} s`);
    publicIds = await rows<string>(
      migrator,
      `SELECT VALUE record::id(id) FROM story WHERE currentStatus.status = 'approved'`,
    );
    const seen = new Set<string>();
    const hearts = [
      ...publicIds
        .slice(0, FAN_HEARTS)
        .map((s) => ({ person: 'fan', story: s })),
      ...Array.from({ length: PEOPLE }, (_, p) =>
        Array.from({ length: 10 }, () => ({
          person: `sp_${p}`,
          story: pick(publicIds),
        })),
      )
        .flat()
        .filter((h) => {
          const key = `${h.person}/${h.story}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
    ];
    for (let from = 0; from < hearts.length; from += 100) {
      await run(migrator, HEARTS_SQL, {
        hearts: hearts.slice(from, from + 100),
      });
    }
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
    report(
      `Loaded in ${Math.round((performance.now() - loadStart) / 1000)} s: ${JSON.stringify(counts)}`,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
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
