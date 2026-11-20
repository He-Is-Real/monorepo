// The web library's lint checks (LB-1, Joel, 20 November 2026), for any website that uses
// @heisreal/web-ui. In its eslint.config.mjs:
//
//   import webUi from '@heisreal/web-ui/eslint';
//   export default [...yourConfig, ...webUi.configs.pages];
//
// - `field-look` (WL-1, Joel, 2026-11-19): text boxes and text areas are the library's `Input`
//   and `Textarea`; a class string with the field look (the input border and background and a
//   focus ring) in a page is a hand-made copy.
// - `no-raw-colour` (OT-1, Joel, 20 November 2026): every colour is the theme's, by meaning
//   (`danger`, `warning`, `brand`… in styles/theme.css). A hex colour, an rgb()/hsl()/oklch()
//   colour, or a Tailwind palette class (`red-600`, `bg-white`, `text-amber-500`) in a page fails.
//   A colour a third party sets (a brand logo) is allowed with an eslint-disable comment that
//   says so.
// Both read every string and template literal, so class names built in constants count too.

/** Whole class names only, in any order: one look-ahead each. */
const has = (name, whole = true) =>
  `(?=.*(?:^|\\s)${name}${whole ? '(?:\\s|$)' : ''})`;
const FIELD_LOOK = new RegExp(
  [
    has('border-input'),
    has('bg-input-background'),
    has('focus-visible:ring', false),
  ].join(''),
);

const PALETTE = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'taupe',
  'mauve',
  'mist',
  'olive',
  'white',
  'black',
].join('|');
const UTILITY = [
  'bg',
  'text',
  'border(?:-[xytrblse])?',
  'outline',
  'ring',
  'ring-offset',
  'inset-ring',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'divide',
  'decoration',
  'shadow',
  'inset-shadow',
  'drop-shadow',
  'text-shadow',
  'accent',
  'caret',
  'placeholder',
].join('|');
/** One class (after its variants, e.g. `dark:hover:`) that names a Tailwind palette colour. */
const PALETTE_CLASS = new RegExp(
  `(?:^|:)!?(?:${UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?:\\/[\\w.\\[\\]-]+)?!?$`,
);
// Not inside a word or a path; `_` is Tailwind's space in arbitrary values (`[0_1px_#000]`).
const HEX =
  /(?<![a-z0-9&#/.-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![a-z0-9-])/i;
const COLOUR_FUNCTION = /(?<![a-z0-9-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
/** `white` or `black` inside an arbitrary value: `[--logo:white]`, `[color-mix(…,white_25%)]` */
const NAMED_IN_ARBITRARY = /\[[^\]]*(?<![a-z0-9-])(?:white|black)(?![a-z0-9-])[^\]]*\]/i;

/** Why a string holds a raw colour, or null. */
export function rawColour(text) {
  if (HEX.test(text)) return 'a hex colour';
  if (COLOUR_FUNCTION.test(text)) return 'a colour function';
  for (const word of text.split(/\s+/)) {
    if (PALETTE_CLASS.test(word)) return `the palette class \`${word}\``;
    if (NAMED_IN_ARBITRARY.test(word)) return `a named colour in \`${word}\``;
  }
  return null;
}

/** Calls `check(text, node)` for every string and template literal part. */
const strings = (check) => ({
  Literal(node) {
    if (typeof node.value === 'string') check(node.value, node);
  },
  TemplateElement(node) {
    check(node.value.raw, node);
  },
});

const plugin = {
  meta: { name: '@heisreal/web-ui' },
  rules: {
    'field-look': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Text boxes and text areas are Input and Textarea from @heisreal/web-ui.',
        },
        schema: [],
        messages: {
          copy: 'Use Input or Textarea from @heisreal/web-ui instead of copying the field look.',
        },
      },
      create: (context) =>
        strings((text, node) => {
          if (FIELD_LOOK.test(text))
            context.report({ node, messageId: 'copy' });
        }),
    },
    'no-raw-colour': {
      meta: {
        type: 'problem',
        docs: {
          description:
            "Colours are the theme's meaning names (@heisreal/web-ui theme.css).",
        },
        schema: [],
        messages: {
          raw: "Use the theme's colour names (danger, warning, success, info, brand, media…; libs/web-ui/README.md) instead of {{what}}.",
        },
      },
      create: (context) =>
        strings((text, node) => {
          // Import paths aren't colours (`logo-white.webp`).
          if (
            node.parent?.type === 'ImportDeclaration' ||
            node.parent?.type === 'ImportExpression'
          )
            return;
          const what = rawColour(text);
          if (what) context.report({ node, messageId: 'raw', data: { what } });
        }),
    },
  },
};

/** Code that never ships to a browser page: tests and their fixtures. */
const NOT_PAGES = [
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.mjs',
  'e2e/**',
  '**/eslint.config.mjs',
];

plugin.configs = {
  /** A website's pages: both checks. */
  pages: [
    {
      files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
      ignores: NOT_PAGES,
      plugins: { '@heisreal/web-ui': plugin },
      rules: {
        '@heisreal/web-ui/field-look': 'error',
        '@heisreal/web-ui/no-raw-colour': 'error',
      },
    },
  ],
  /** The library itself: colours only (it defines the field look). */
  library: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      ignores: NOT_PAGES,
      plugins: { '@heisreal/web-ui': plugin },
      rules: { '@heisreal/web-ui/no-raw-colour': 'error' },
    },
  ],
};

export default plugin;
