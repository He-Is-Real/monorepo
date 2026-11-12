import {
  agreeAll,
  createPeople,
  rows,
  run,
  type TestDatabase,
} from '@heisreal/database/integration-testing';

/**
 * The scale test's dataset (LOCAL ONLY): deterministic, loaded through the real write path (a
 * system user, as dev-seed loads: every event and check runs). Its text is part of the scale
 * volume's key (global-setup.ts): change it and the next run loads afresh.
 */
export const PEOPLE = 2_000;
// Small transactions: 3.2.4 slows down sharply as one transaction grows (500 stories at once:
// 0.3 s a story; 25 at once: 22 ms).
const BATCH = 25;
export const CATEGORIES = 8;
export const THEMES_PER_CATEGORY = 8;
export const FAN_HEARTS = 5_000;

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
export const COMMON = 'faith';
export const RARE = 'lighthouse';

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
  action: string;
  actor: 'person' | 'moderator';
  comment?: string;
};

/** A story's history, from its first submission to its status now (mostly approved). */
function history(): Step[] {
  const p = (action: string): Step => ({ action, actor: 'person' });
  const m = (action: string, comment?: string): Step => ({
    action,
    actor: 'moderator',
    comment,
  });
  const r = random();
  if (r < 0.05) return [];
  if (r < 0.13) return [p('sent')];
  if (r < 0.17) return [p('sent'), m('rejected', 'Sorry')];
  if (r < 0.21)
    return [
      p('sent'),
      m('changesRequested', 'Please shorten it'),
      p('sent'),
      p('editStarted'),
    ];
  const steps: Step[] = [p('sent')];
  if (random() < 0.3)
    steps.push(m('changesRequested', 'A small change'), p('sent'));
  steps.push(m('approved'));
  const later = random();
  if (later < 0.1)
    steps.push(m('hiddenByModerator', 'Checking'), m('shownByModerator'));
  else if (later < 0.15) steps.push(p('editStarted'));
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
      story: $story, action: $step.action, actor: $step.actor, at: $step.at,
      by: IF $step.actor = 'moderator' { user:sp_moderator },
      comment: $step.comment,
      publishedAt: IF $step.action IN ['approved', 'shownByModerator'] { $s.publishedAt }
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

/**
 * Loads `stories` stories, their people, themes, files, history and hearts into `t` (a fresh
 * database with the schema), as described in scale.scale-spec.ts. `report` gets progress lines.
 */
export async function loadDataset(
  t: TestDatabase,
  stories: number,
  report: (line: string) => void,
): Promise<void> {
  const STORIES = stories;
  const loadStart = performance.now();
  const migrator = await t.migrator();
  await createPeople(t, { fan: 'user_fan' });
  await agreeAll(await t.person('user_fan'));
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
             name = 'Topic' + $letters[$c] + $letters[$k],
             category = type::record('themeCategory', 'c' + <string> $c) RETURN NONE;
         };
       };`,
    {
      people: PEOPLE,
      categories: CATEGORIES,
      perCategory: THEMES_PER_CATEGORY,
      letters: 'abcdefgh'.split(''),
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
  const publicIds = await rows<string>(
    migrator,
    `SELECT VALUE record::id(id) FROM story WHERE currentStatus.status = 'approved'`,
  );
  const seen = new Set<string>();
  const hearts = [
    ...publicIds.slice(0, FAN_HEARTS).map((s) => ({ person: 'fan', story: s })),
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
}
