#!/usr/bin/env node
// `pnpm agents:doctor`: what agents working in this repo see. No AI, no dependencies.
//
//   node tools/scripts/agents-doctor.mjs --repo   # the repo half; run in CI, fails on a problem
//   node tools/scripts/agents-doctor.mjs          # the machine half; on request, never fails
//
// The machine half lists what an agent on this machine sees that a fresh clone does not. It prints
// counts and names only, never file contents or secrets.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const REQUIRED_PLUGINS = [
  'superpowers',
  'code-review',
  'security-review',
  'frontend-design',
];

// Files written on Windows may end lines in CRLF; parse them as LF.
const lf = (text) => text.replace(/\r\n?/g, '\n');

if (process.argv.includes('--repo')) {
  const problems = [];
  const skills = join(root, '.agents/skills');
  for (const name of existsSync(skills) ? readdirSync(skills) : []) {
    const file = join(skills, name, 'SKILL.md');
    if (!existsSync(file)) {
      problems.push(`.agents/skills/${name}: no SKILL.md`);
      continue;
    }
    const text = lf(readFileSync(file, 'utf8'));
    const head = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
    if (!new RegExp(`^name: ${name}\\s*$`, 'm').test(head))
      problems.push(
        `.agents/skills/${name}/SKILL.md: front matter needs "name: ${name}"`,
      );
    if (!/^description: \S/m.test(head))
      problems.push(
        `.agents/skills/${name}/SKILL.md: front matter needs a description (when to use the skill)`,
      );
    const lines = text.split('\n').length;
    if (lines >= 500)
      problems.push(
        `.agents/skills/${name}/SKILL.md: ${lines} lines, keep it under 500; move detail to files beside it`,
      );
  }
  const link = join(root, '.claude/skills');
  if (
    !existsSync(link) ||
    !lstatSync(link).isSymbolicLink() ||
    realpathSync(link) !== realpathSync(skills)
  )
    problems.push(
      '.claude/skills must be a relative link to ../.agents/skills (ln -s ../.agents/skills .claude/skills)',
    );
  const agentsFiles = execFileSync(
    'git',
    ['-C', root, 'ls-files', '*AGENTS.md'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => f.endsWith('/AGENTS.md') && !f.includes('/fixtures/')); // test fixtures are not agent folders
  for (const f of agentsFiles) {
    const claude = join(root, dirname(f), 'CLAUDE.md');
    const text = existsSync(claude)
      ? lf(readFileSync(claude, 'utf8')).trim()
      : '';
    if (text !== '@AGENTS.md')
      problems.push(
        `${dirname(f)}/CLAUDE.md must exist beside ${f} and hold the one line "@AGENTS.md"`,
      );
  }
  for (const p of problems) console.error(p);
  console.log(
    problems.length
      ? `agents:doctor: ${problems.length} problem(s)`
      : 'agents:doctor: repo OK',
  );
  process.exit(problems.length ? 1 : 0);
}

// --- Machine half: never fails ---------------------------------------------------------------
const home = homedir();
const say = (label, value) => console.log(`${label.padEnd(30)} ${value}`);
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
};

// Claude Code keeps a project's files under ~/.claude/projects/<path, other characters as "-">, for
// the folder it was started in: this checkout, the main checkout of a worktree, or a parent folder.
const encode = (p) => p.replace(/\/$/, '').replace(/[^A-Za-z0-9]/g, '-');
let main = root;
try {
  main = dirname(
    execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    ).trim(),
  );
} catch {
  /* not git */
}
const projects = join(home, '.claude/projects');
const memCount = (existsSync(projects) ? readdirSync(projects) : [])
  .filter(
    (d) =>
      d.length > encode(home).length &&
      [root, main].some((p) => `${encode(p)}-`.startsWith(`${d}-`)),
  )
  .map((d) => join(projects, d, 'memory'))
  .filter(existsSync)
  .reduce(
    (n, dir) => n + readdirSync(dir).filter((f) => f.endsWith('.md')).length,
    0,
  );
say(
  'Private memory files',
  memCount
    ? `${memCount} (a clone does not have them; project rules belong in the repo)`
    : 'none',
);

const enabled = Object.entries(
  readJson(join(home, '.claude/settings.json'))?.enabledPlugins ?? {},
)
  .filter(([, on]) => on)
  .map(([name]) => name);
say('Claude plugins switched on', enabled.length ? enabled.join(', ') : 'none');
const missing = REQUIRED_PLUGINS.filter(
  (p) => !enabled.some((e) => e.split('@')[0] === p),
);
say(
  'Required plugins missing',
  missing.length
    ? `${missing.join(', ')}: install them in Claude Code (/plugin)`
    : 'none',
);

for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md'])
  say(
    `User-level ~/${f}`,
    existsSync(join(home, f))
      ? 'present (applies to you only, not to a clone)'
      : 'none',
  );

// Command-line tools from the table in docs/tooling-and-accounts.md ("Command-line tools").
const doc = lf(
  readFileSync(join(root, 'docs/tooling-and-accounts.md'), 'utf8'),
);
const section = doc.split('## Command-line tools')[1]?.split('\n## ')[0] ?? '';
const ALIAS = { 'node.js': 'node', opentofu: 'tofu', imagemagick: 'magick' };
const tools = section
  .split('\n')
  .filter((l) => l.startsWith('| **'))
  .flatMap((row) => {
    const [first, , install = ''] = row
      .split('|')
      .slice(1)
      .map((c) => c.trim());
    if (/devDependency|nothing to install|playwright install/i.test(install))
      return [];
    const named = first.match(/\(`([\w-]+)`/);
    if (named) return [named[1]];
    return first
      .match(/\*\*(.+?)\*\*/)[1]
      .split(/[,+]/)
      .map((n) => {
        const word = n.trim().split(' ')[0].toLowerCase();
        return ALIAS[word] ?? word;
      });
  });
const absent = tools.filter(
  (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status !== 0,
);
say(
  'Missing command-line tools',
  absent.length
    ? `${absent.join(', ')} (see docs/tooling-and-accounts.md)`
    : 'none',
);
