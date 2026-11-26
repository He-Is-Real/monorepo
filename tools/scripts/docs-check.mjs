#!/usr/bin/env node
// `pnpm docs:check`: checks the rule files under docs/ against the format in
// .agents/skills/writing-the-reference/SKILL.md. Plain Node, no dependencies, the same result
// locally and in CI. Every message names the rule and the fix.
//
//   node tools/scripts/docs-check.mjs [--root <dir>] [--base <git ref>]
//
// --base (CI on pull requests): rules and principles changed since the merge base must carry a
// tag whose register row exists and is not withdrawn or replaced; a new tag needs its row in the
// same change. A wording fix that keeps its tag passes.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The root AGENTS.md must stay within its limit.
const ROOT_LIMIT_ENFORCED = true;
// About 240 old decision ids are still cited; a later change removes them and turns this on.
const OLD_IDS_ENFORCED = false;

const LIMITS = {
  rule: 50,
  sentences: 2,
  why: 25,
  position: 40,
  section: 60,
  file: 300,
  contents: 100,
  root: 150,
  decided: 20,
};
const REGISTER = 'docs/decisions/register.md';
const RULE_ID = String.raw`(?:REQ-[A-Z]{2,4}-\d{3}|WORK-\d{3})`;
const ANY_ID = new RegExp(
  String.raw`\b(?:REQ-[A-Z]{2,4}-\d{3}|WORK-\d{3}|PRIN-\d{2})\b`,
  'g',
);
const RULE_LINE = new RegExp(
  String.raw`^- \*\*(${RULE_ID})\*\* (.+?)( \(planned\))? \[([A-Za-z0-9.-]+)\]$`,
);
const STATUS = /^(approved, not built|in force|replaced by \S+|withdrawn)$/;
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const HISTORY = [
  'used to',
  'previously',
  'no longer',
  'formerly',
  'superseded',
];
const SOFT = [
  'should',
  'usually',
  'generally',
  'appropriate',
  'where possible',
  'as needed',
  'TBD',
];
const BANNED = [
  [
    new RegExp(
      String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:${MONTHS})[a-z]* \d{4}\b`,
    ),
    'a date; dates live in the register, remove it',
  ],
  [/\bJoel\b/, 'a name; approvals live in the register, remove it'],
  [/(?<![\w&])#\d+\b/, 'a pull request number; git keeps it, remove it'],
  [
    /\S*\.html\b|context\/research/,
    'a decision doc link; only the register names one, cite the rule id',
  ],
  ...HISTORY.map((w) => [
    new RegExp(String.raw`\b${w}\b`, 'i'),
    'history; state only what is true now',
    'history',
  ]),
  ...SOFT.map((w) => [
    new RegExp(String.raw`\b${w}\b`, 'i'),
    'a soft word; say exactly what happens',
  ]),
];

const args = process.argv.slice(2);
const opt = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = opt('--root') ?? fileURLToPath(new URL('../..', import.meta.url));
const base = opt('--base');

const errors = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const lf = (text) => text.replace(/\r\n?/g, '\n');
const read = (rel) =>
  lf(readFileSync(join(root, rel), 'utf8'))
    .replace(/\n$/, '')
    .split('\n');
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
// Text outside "quotes" and code spans (any number of backticks), where the banned words apply.
const plain = (s) =>
  s
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '``')
    .replace(/"[^"]*"|“[^”]*”/g, '""');
const sentences = (s) =>
  Math.max(
    1,
    (
      plain(s)
        .replace(/\b(e\.g|i\.e|etc)\./g, '$1')
        .match(/[.!?](?=\s|$)/g) ?? []
    ).length,
  );

// For each line, whether it is inside a fenced code block (the fence lines included). A fence
// opens on three or more backticks or tildes plus an info string without backticks (so ```x``` is
// inline code), and closes on a line that is only a fence of the same character, at least as long.
const fenced = (lines) => {
  let fence = null;
  return lines.map((l) => {
    if (fence) {
      const c = l.match(/^\s*(`{3,}|~{3,}) *$/);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length)
        fence = null;
      return true;
    }
    const o = l.match(/^\s*(`{3,}|~{3,})[^`]*$/);
    if (o) fence = o[1];
    return Boolean(o);
  });
};

const walk = (rel) => {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return rel.endsWith('.md') ? [rel] : [];
  return readdirSync(abs)
    .sort()
    .flatMap((f) => walk(`${rel}/${f}`));
};
const ruleFiles = [
  ...walk('docs/product'),
  ...walk('docs/system'),
  ...walk('docs/process/working-agreements.md'),
];
const referenceFiles = [
  'docs/product',
  'docs/system',
  'docs/process',
  'docs/runbooks',
].flatMap(walk);
const termFile = (f) =>
  f === 'docs/product/glossary.md' || f === 'docs/product/actors.md';

// --- Register -------------------------------------------------------------------------------
const parseRegister = (lines) => {
  const rows = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells[0] === 'Id' || /^:?-+:?$/.test(cells[0])) return;
    rows.push({ line: i + 1, cells, id: cells[0], status: cells[4] });
  });
  return rows;
};
const register = existsSync(join(root, REGISTER))
  ? parseRegister(read(REGISTER))
  : [];
const registerIds = new Map(register.map((r) => [r.id, r]));

// --- Rule files -----------------------------------------------------------------------------
const ids = new Map(); // id -> "file:line"
const tagged = []; // { id, tag, file, from, to } for rules and principles

const checkBanned = (file, n, line) => {
  let text = plain(line).replace(/ \[[A-Za-z0-9.-]+\]$/, '');
  if (/^\[[A-Za-z0-9.-]+\]$/.test(text.trim())) return;
  const notPart = termFile(file) ? text.indexOf(' Not: ') : -1;
  for (const [re, why, kind] of BANNED) {
    const scope =
      kind === 'history' && notPart >= 0 ? text.slice(0, notPart) : text;
    const m = scope.match(re);
    if (m) fail(`${file}:${n}`, `banned "${m[0]}" (${why})`);
  }
};

const checkSizes = (file, lines, isRuleFile) => {
  if (isRuleFile && lines.length > LIMITS.file)
    fail(file, `${lines.length} lines, limit ${LIMITS.file}; split the file`);
  if (
    lines.length > LIMITS.contents &&
    !lines.slice(0, 20).some((l) => /^(#+ )?\**contents\**:?\s*$/i.test(l))
  )
    fail(
      file,
      `${lines.length} lines; add a contents list near the top (a "## Contents" heading in the first 20 lines)`,
    );
  if (!isRuleFile) return;
  const heads = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []));
  heads.forEach((start, k) => {
    const size = (heads[k + 1] ?? lines.length) - start;
    if (size > LIMITS.section)
      fail(
        `${file}:${start + 1}`,
        `section "${lines[start].slice(3)}" is ${size} lines, limit ${LIMITS.section}; split it under two headings`,
      );
  });
};

const addId = (id, where) => {
  if (ids.has(id))
    fail(
      where,
      `duplicate id ${id} (also at ${ids.get(id)}); take the next number from the file's "Next id:" line`,
    );
  else ids.set(id, where);
};

const checkRules = (file, lines) => {
  const code = fenced(lines);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    if (code[i]) continue;
    checkBanned(file, n, lines[i]);
    if (termFile(file) || !lines[i].startsWith('- **')) continue;
    const m = lines[i].match(RULE_LINE);
    if (!m) {
      fail(
        `${file}:${n}`,
        'rule line must be "- **<id>** <text> [<tag>]" on one line, id REQ-<AREA>-<NNN> or WORK-<NNN>, an optional " (planned)" before the tag, the tag last; fix its shape',
      );
      continue;
    }
    const [, id, text, , tag] = m;
    addId(id, `${file}:${n}`);
    // A [tag]-shaped bracket that is no link: not [text](url), nor either half of [text][ref].
    if (/(?<!\])\[[A-Za-z0-9.-]+\](?![([])/.test(plain(text)))
      fail(
        `${file}:${n}`,
        `${id}: a rule has exactly one [tag], the last thing on the line; remove the others`,
      );
    if (words(text) > LIMITS.rule)
      fail(
        `${file}:${n}`,
        `${id}: ${words(text)} words, limit ${LIMITS.rule}; split it`,
      );
    if (sentences(text) > LIMITS.sentences)
      fail(
        `${file}:${n}`,
        `${id}: ${sentences(text)} sentences, limit ${LIMITS.sentences}; split it`,
      );
    const seen = new Set();
    let j = i + 1;
    for (; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
      checkBanned(file, j + 1, lines[j]);
      const f = lines[j].match(/^ {2}(Why|Example|Not): \S/);
      if (!f || seen.has(f[1])) {
        fail(
          `${file}:${j + 1}`,
          `${id}: a rule is one physical line, followed only by one Why:, Example: and Not: line each; join the line or drop the extra`,
        );
        continue;
      }
      seen.add(f[1]);
      const w = words(lines[j]) - 1;
      if (f[1] === 'Why' && w > LIMITS.why)
        fail(
          `${file}:${j + 1}`,
          `${id}: Why: is ${w} words, limit ${LIMITS.why}; keep one short reason`,
        );
    }
    tagged.push({ id, tag, file, from: n });
    i = j - 1;
  }
};

const checkPrinciples = (file, lines) => {
  lines.forEach((line, i) => {
    if (!line.startsWith('## PRIN')) return;
    const h = line.match(/^## (PRIN-\d{2}) \S/);
    if (!h)
      return fail(
        `${file}:${i + 1}`,
        'principle heading must be "## PRIN-<NN> <short name>"',
      );
    const id = h[1];
    addId(id, `${file}:${i + 1}`);
    let end = lines.findIndex((l, k) => k > i && l.startsWith('## '));
    if (end < 0) end = lines.length;
    const body = lines
      .slice(i + 1, end)
      .map((l, k) => [l.trim(), i + 2 + k])
      .filter(([l]) => l);
    // The position is every line before the first field; then each field once, then the tag.
    const FIELD = /^(Why|Applies|Except): \S/;
    const TAG = /^\[([A-Za-z0-9.-]+)\]$/;
    let k = 0;
    while (k < body.length && !FIELD.test(body[k][0]) && !TAG.test(body[k][0]))
      k++;
    const position = body
      .slice(0, k)
      .map(([l]) => l)
      .join(' ');
    if (!position)
      fail(`${file}:${i + 1}`, `${id}: first line must be the position`);
    else if (words(position) > LIMITS.position)
      fail(
        `${file}:${i + 1}`,
        `${id}: position is ${words(position)} words, limit ${LIMITS.position}; shorten it`,
      );
    const fields = new Map();
    body.slice(k).forEach(([l, n], x, rest) => {
      const f = l.match(FIELD);
      if (f && !fields.has(f[1])) fields.set(f[1], [l, n]);
      else if (f)
        fail(
          `${file}:${n}`,
          `${id}: a second ${f[1]}: line; keep one ${f[1]}: line`,
        );
      else if (!TAG.test(l) || x !== rest.length - 1)
        fail(
          `${file}:${n}`,
          `${id}: a principle is a position, then Why:, Applies:, an optional Except: and the [tag] last; remove or move this line`,
        );
    });
    const why = fields.get('Why');
    if (!why)
      fail(
        `${file}:${i + 1}`,
        `${id}: no Why: line; an opinion always gives its reason`,
      );
    else if (words(why[0]) - 1 > LIMITS.why)
      fail(
        `${file}:${why[1]}`,
        `${id}: Why: is ${words(why[0]) - 1} words, limit ${LIMITS.why}`,
      );
    if (!fields.has('Applies'))
      fail(
        `${file}:${i + 1}`,
        `${id}: no Applies: line; say where the opinion bites`,
      );
    const last = body.at(-1)?.[0].match(TAG);
    if (!last)
      fail(
        `${file}:${i + 1}`,
        `${id}: the last line must be the tag, "[<decision id>]"`,
      );
    else tagged.push({ id, tag: last[1], file, from: i + 1 });
  });
};

const checkNextId = (file, lines) => {
  if (termFile(file)) return;
  const line = lines.slice(0, 10).find((l) => l.startsWith('Next id:'));
  const m = line?.match(/^Next id: ((REQ-[A-Z]{2,4}|WORK|PRIN)-(\d+))\s*$/);
  if (!m)
    return fail(
      file,
      'no "Next id:" line in the first 10 lines; add one, e.g. "Next id: REQ-MOD-001"',
    );
  for (const [id, where] of ids) {
    if (!where.startsWith(`${file}:`)) continue;
    const num = Number(id.split('-').at(-1));
    if (!id.startsWith(`${m[2]}-`))
      fail(
        where,
        `${id} does not match the file's "Next id: ${m[1]}"; use the file's prefix`,
      );
    else if (num >= Number(m[3]))
      fail(
        where,
        `${id} is at or above "Next id: ${m[1]}"; raise Next id above ${id}`,
      );
  }
};

for (const file of ruleFiles) {
  const lines = read(file);
  checkSizes(file, lines, true);
  if (file === 'docs/product/principles.md') checkPrinciples(file, lines);
  checkRules(file, lines);
  checkNextId(file, lines);
}
for (const file of referenceFiles.filter((f) => !ruleFiles.includes(f))) {
  const lines = read(file);
  checkSizes(file, lines, false);
  lines.forEach((l, i) => {
    if (/\S*\.html\b|context\/research/.test(plain(l)))
      fail(
        `${file}:${i + 1}`,
        'links to a decision doc; only the register names one, cite the rule id instead',
      );
  });
}

// --- Tags and the register ------------------------------------------------------------------
if (tagged.length && !register.length)
  fail(REGISTER, 'missing or empty; every tag needs a row there');
for (const t of tagged)
  if (!registerIds.has(t.tag))
    fail(
      `${t.file}:${t.from}`,
      `${t.id}: tag [${t.tag}] has no row in ${REGISTER}; add the row (Id, Date, Decided, Now at, Status, Source)`,
    );
const seenRows = new Set();
for (const r of register) {
  const where = `${REGISTER}:${r.line}`;
  if (r.cells.length !== 6) {
    fail(
      where,
      `row has ${r.cells.length} cells, expected 6 (Id, Date, Decided, Now at, Status, Source)`,
    );
    continue;
  }
  if (seenRows.has(r.id))
    fail(where, `duplicate register id ${r.id}; one row per decision`);
  seenRows.add(r.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.cells[1]))
    fail(where, `${r.id}: date "${r.cells[1]}" must be YYYY-MM-DD`);
  if (words(r.cells[2]) > LIMITS.decided)
    fail(
      where,
      `${r.id}: "Decided" is ${words(r.cells[2])} words, limit ${LIMITS.decided}`,
    );
  if (!STATUS.test(r.status))
    fail(
      where,
      `${r.id}: status "${r.status}" is not one of: approved, not built · in force · replaced by <id> · withdrawn`,
    );
  for (const raw of r.cells[3].split(/[,;]/)) {
    const item = raw.trim().replace(/^`|`$/g, '');
    if (!item || item === 'removed') continue;
    if (new RegExp(`^${RULE_ID}$|^PRIN-\\d{2}$`).test(item)) {
      if (!ids.has(item))
        fail(
          where,
          `${r.id}: "Now at" names ${item}, which no rule file has; fix the id or add the rule`,
        );
    } else if (!existsSync(join(root, item))) {
      fail(
        where,
        `${r.id}: "Now at" names ${item}, which is neither a known id nor an existing path; fix it`,
      );
    }
  }
}

// --- Changes since --base (KS-10) -------------------------------------------------------------
if (base) {
  const git = (...a) =>
    execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  // A rule or principle has changed when its full text differs from the base version's (an
  // added, edited or deleted line all count).
  // Lines in fenced code blocks are examples, never the rule itself.
  const block = (lines, id) => {
    const code = fenced(lines);
    const i = lines.findIndex(
      (l, k) =>
        !code[k] && (l.startsWith(`- **${id}** `) || l.startsWith(`## ${id} `)),
    );
    if (i < 0) return undefined;
    const more = lines[i].startsWith('## ')
      ? (l, k) => code[k] || !l.startsWith('## ')
      : (l) => /^\s+\S/.test(l);
    let j = i + 1;
    while (j < lines.length && more(lines[j], j)) j++;
    return lines.slice(i, j).join('\n').trimEnd();
  };
  const baseLines = new Map();
  const before = (file) => {
    if (!baseLines.has(file)) {
      let text = '';
      try {
        text = lf(
          execFileSync('git', ['-C', root, 'show', `${mergeBase}:${file}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }),
        );
      } catch {
        /* a new file */
      }
      baseLines.set(file, text.split('\n'));
    }
    return baseLines.get(file);
  };
  for (const t of tagged) {
    if (block(read(t.file), t.id) === block(before(t.file), t.id)) continue;
    const row = registerIds.get(t.tag);
    // A new tag's row exists only if this change added it.
    if (!row)
      fail(
        `${t.file}:${t.from}`,
        `${t.id} changed: its tag [${t.tag}] has no register row; add the row in this change`,
      );
    else if (/^(withdrawn|replaced by)/.test(row.status))
      fail(
        `${t.file}:${t.from}`,
        `${t.id} changed: its tag [${t.tag}] is ${row.status}; tag it with the decision that approved this change`,
      );
  }
}

// --- Root file size (KS-5) ------------------------------------------------------------------
if (existsSync(join(root, 'AGENTS.md'))) {
  const n = read('AGENTS.md').length;
  const msg = `${n} lines, limit ${LIMITS.root}; move folder rules to folder AGENTS.md files or skills`;
  if (n > LIMITS.root)
    (ROOT_LIMIT_ENFORCED
      ? fail
      : (w, m) => warnings.push(`${w}: ${m} (warning only for now)`))(
      'AGENTS.md',
      msg,
    );
}

// --- Old decision ids cited without a register row --------------------------------------------
// Ids shaped like D72, LG-9b, TX-8 or J-2026-11-08 in tracked text files. Approximate on purpose:
// it only counts until the old ids are gone.
const OLD_ID =
  /\b(?:D\d{1,3}|[A-Z]{1,4}-\d{1,2}[a-z]?|J-\d{4}-\d{2}-\d{2}[a-z]?)\b/g;
const NOT_IDS =
  /^(REQ|WORK|PRIN|UTF|SHA|ISO|RFC|AES|TLS|CVE|ES|HS|RS|PS|GDPR|PR|ID|UK|EU|UTC|GMT|HTTP|IP|E|N|A|B|C|K|M|P|S|T|X|V)-/;
let tracked = [];
try {
  tracked = execFileSync('git', ['-C', root, 'ls-files'], {
    encoding: 'utf8',
  }).split('\n');
} catch {
  /* not a git checkout */
}
const cited = new Map();
for (const f of tracked.filter(
  (f) =>
    /\.(md|mdx|ts|tsx|mjs|js|ya?ml|tf|json|sh|surql|py)$/.test(f) &&
    f !== REGISTER &&
    !f.includes('fixtures/'),
)) {
  let text;
  try {
    text = readFileSync(join(root, f), 'utf8');
  } catch {
    continue;
  }
  for (const id of text.match(OLD_ID) ?? [])
    if (!NOT_IDS.test(id) && !registerIds.has(id) && !cited.has(id))
      cited.set(id, f);
}
if (cited.size) {
  if (OLD_IDS_ENFORCED)
    for (const [id, f] of cited)
      fail(
        f,
        `decision id ${id} has no register row; add the row or cite the rule id instead`,
      );
  else
    console.log(
      `docs:check: ${cited.size} decision ids are cited without a register row (not enforced yet)`,
    );
}

for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(
    `docs:check: ${errors.length} problem(s); the format is in .agents/skills/writing-the-reference/SKILL.md`,
  );
  process.exit(1);
}
console.log(
  `docs:check: ${ruleFiles.length} rule files, ${ids.size} ids, ${register.length} register rows; OK`,
);
