// Probes for the library's lint checks (eslint/index.mjs): linting page code with its `pages`
// config, each raw colour or copied field look must fail, and the theme's names must pass.
// Run by web-ui's `lint-rules` target (before `lint`).
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import webUi from './index.mjs';

const cwd = dirname(fileURLToPath(import.meta.url));
const eslint = new ESLint({
  cwd,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.tsx'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    ...webUi.configs.pages,
  ],
});

async function rules(code) {
  const [result] = await eslint.lintText(code, {
    filePath: `${cwd}/src/app/probe/page.tsx`,
  });
  return result.messages
    .map((m) => m.ruleId)
    .filter((id) => id?.startsWith('@heisreal/web-ui/'));
}

const page = (className) =>
  `export default function P() { return <p className=${className}>x</p>; }`;

describe('no-raw-colour', () => {
  for (const [what, cls] of [
    ['a palette class', '"text-red-600"'],
    [
      'a palette class with a variant and opacity',
      '"dark:hover:bg-amber-500/40"',
    ],
    ['white', '"text-white"'],
    ['black with opacity', '"bg-black/55"'],
    ['an arbitrary hex', '"bg-[#111113]"'],
    ['a hex in a constant', "{'#c62828'}"],
    ['rgb()', '"bg-[rgb(78_155_160/0.15)]"'],
    ['a named colour in an arbitrary value', '"[--logo:white]"'],
    [
      'white in color-mix',
      '"text-[color-mix(in_srgb,var(--danger),white_25%)]"',
    ],
    ['rgb() in a shadow', '"shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]"'],
    ['a hex in a shadow', '"shadow-[0_1px_#000]"'],
    ['a named colour in an arbitrary colour utility', '"text-[red]"'],
    ['a named colour in an arbitrary property', '"[color:rebeccapurple]"'],
    ['a template literal', '{`p-2 ${"x"} border-emerald-400`}'],
  ])
    it(`fails on ${what}`, async () =>
      assert.deepEqual(await rules(page(cls)), [
        '@heisreal/web-ui/no-raw-colour',
      ]));

  for (const [what, cls] of [
    [
      'meaning names',
      '"text-danger-text bg-danger/10 border-warning text-on-media bg-media/55"',
    ],
    ['brand names', '"border-brand hover:bg-brand-bright text-hero"'],
    [
      'a theme variable in color-mix',
      '"bg-[color-mix(in_srgb,var(--brand)_15%,transparent)]"',
    ],
    ['a link to a heading', '"#main"'],
  ])
    it(`passes ${what}`, async () =>
      assert.deepEqual(await rules(page(cls)), []));

  for (const [what, code] of [
    [
      'colour words in style',
      `export const P = () => <p style={{ color: 'red', backgroundColor: 'white' }}>x</p>;`,
    ],
    [
      'a hex in style',
      `export const P = () => <p style={{ borderColor: '#c62828' }}>x</p>;`,
    ],
    [
      'a named colour in a style shorthand',
      `export const P = () => <p style={{ border: '1px solid navy' }}>x</p>;`,
    ],
    [
      'a named colour in an SVG fill',
      `export const P = () => <svg><path fill="red" /></svg>;`,
    ],
    [
      'a named colour in a gradient stop',
      `export const P = () => <svg><stop stopColor="gold" /></svg>;`,
    ],
  ])
    it(`fails on ${what}`, async () => {
      const found = await rules(code);
      assert.ok(found.length > 0, 'reported');
      assert.ok(found.every((id) => id === '@heisreal/web-ui/no-raw-colour'));
    });

  for (const [what, code] of [
    [
      'a link to an id that looks like hex',
      `export const P = () => <a href="#add">Add</a>;`,
    ],
    [
      'a link built in an object',
      `export const l = { href: '#bad', to: '#fade' };`,
    ],
    [
      'an id that looks like hex',
      `export const P = () => <h2 id="add">x</h2>;`,
    ],
    [
      'colour words in ordinary text',
      `export const P = () => <p title="Red Sea and white water">{'Read the red and white notes'}</p>;`,
    ],
    [
      'a theme variable in style',
      `export const P = () => <p style={{ color: 'var(--danger)', background: 'linear-gradient(145deg, var(--art-1-from), var(--art-1-to))' }}>x</p>;`,
    ],
    [
      'currentColor in an SVG fill',
      `export const P = () => <svg><path fill="currentColor" /></svg>;`,
    ],
  ])
    it(`passes ${what}`, async () => assert.deepEqual(await rules(code), []));

  it('passes an import path that names a colour', async () =>
    assert.deepEqual(
      await rules(
        `import logo from '../assets/logo-white.webp'; export const l = logo;`,
      ),
      [],
    ));
});

describe('field-look', () => {
  it('fails on a copied field look', async () =>
    assert.deepEqual(
      await rules(
        page('"h-11 border-input bg-input-background focus-visible:ring-2"'),
      ),
      ['@heisreal/web-ui/field-look'],
    ));
});
