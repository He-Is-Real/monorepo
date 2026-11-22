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
// - `no-text-look` (TX-7 A, Joel, 21 November 2026): text looks are the library's `Heading`,
//   `Text`, `Quote` and `TextLink`. A text colour, size, weight, line height, letter spacing,
//   capitals or italics class in a page fails. Only strings that read as class lists count (every
//   word class-like), so ordinary words in sentences never do. A page that truly needs its own
//   look (the styling order's last step) wraps it in an eslint-disable comment that says why.
// They read every string and template literal, so class names built in constants count too.

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
const COLOUR_FUNCTION =
  /(?<![a-z0-9-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
/** CSS's named colours (CSS Color 4), as whole words. */
const CSS_NAMED = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
].join('|');
/** A named colour as a whole word (not part of a longer word or a `--variable`). */
const NAMED_WORD = new RegExp(
  `(?<![a-z0-9-])(?:${CSS_NAMED})(?![a-z0-9-])`,
  'i',
);
/**
 * A Tailwind colour utility with an arbitrary value (`text-[red]`, `bg-[color:navy]`), or an
 * arbitrary colour property (`[color:red]`, `[--logo:white]`): group 1 is the value. Not
 * `content-['Red']` (text), not a selector variant (`[&_.red]:block`).
 */
const ARBITRARY_COLOUR_VALUE = new RegExp(
  `(?:^|:)!?(?:(?:${UTILITY})-\\[([^\\]]*)\\]|\\[(?:--[\\w-]+|color|background(?:-color)?|border(?:-[a-z]+)*-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color):([^\\]]*)\\])!?$`,
  'i',
);
/** A url(…) and quoted text aren't colours: `bg-[url('/images/red.webp')]`, `fill="url(#red)"`. */
const withoutUrls = (text) => text.replace(/url\([^)]*\)/gi, 'url()');
const withoutQuoted = (text) =>
  withoutUrls(text).replace(/'[^']*'|"[^"]*"/g, "''");

/**
 * Attributes and keys whose value is a link, a fragment or a name, never a colour: `#add` there
 * is a link to an id, not a hex colour.
 */
const NOT_A_COLOUR_KEY =
  /^(?:href|to|src|srcSet|action|formAction|id|htmlFor|for|name|key|target|rel|hash|url|pathname|path|as|aria-[\w-]+|data-[\w-]+)$/i;
/**
 * Attributes and style keys that take a colour: in these, a plain colour word (`red`) is a raw
 * colour too. `color`, `backgroundColor`, `borderTopColor`, `background`, `border`, `fill`,
 * `stopColor`, `boxShadow`… (not `borderRadius` or `borderWidth`).
 */
const COLOUR_KEY =
  /colou?r$|^(?:background|backgroundImage|border(?:Top|Right|Bottom|Left|(?:Block|Inline)(?:Start|End)?)?|outline|fill|stroke|boxShadow|textShadow|textDecoration|columnRule|mask|filter)$/i;

/**
 * Why a string holds a raw colour, or null. `key` is its attribute or property name, if any.
 * Named colours (`red`) count only where a colour goes: a colour attribute or style key, or a
 * Tailwind arbitrary colour value; never in ordinary text, quoted text or a url(…).
 */
export function rawColour(text, key) {
  const urlLike = key !== undefined && NOT_A_COLOUR_KEY.test(key);
  if (!urlLike && HEX.test(withoutUrls(text))) return 'a hex colour';
  if (COLOUR_FUNCTION.test(text)) return 'a colour function';
  if (
    key !== undefined &&
    COLOUR_KEY.test(key) &&
    NAMED_WORD.test(withoutQuoted(text))
  )
    return 'a named colour';
  for (const word of text.split(/\s+/)) {
    if (PALETTE_CLASS.test(word)) return `the palette class \`${word}\``;
    const arbitrary = ARBITRARY_COLOUR_VALUE.exec(word);
    if (
      arbitrary &&
      NAMED_WORD.test(withoutQuoted(arbitrary[1] ?? arbitrary[2]))
    )
      return `a named colour in \`${word}\``;
  }
  return null;
}

/** `text-*` utilities that place or wrap text rather than style it: layout, allowed. */
const TEXT_LAYOUT =
  /^text-(?:left|right|center|justify|start|end|balance|pretty|wrap|nowrap|ellipsis|clip)$/;
/** A text look, after its variants (`sm:`, `hover:`, `group-open:`) and `!`. */
const TEXT_LOOK =
  /^(?:text-.+|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|mono|serif|sans|\[.+\]|\(.+\))|leading-.+|tracking-.+|uppercase|lowercase|capitalize|normal-case|italic|not-italic)$/;
/** One word as a Tailwind class could be written: no capitals, no sentence punctuation. */
const CLASS_LIKE = /^[a-z0-9!@:\-[\]()/&_.%,#'*>=+~]+$/;

/** The first text-look class in a class list, or null (null too for text that isn't one). */
export function textLook(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || !words.every((w) => CLASS_LIKE.test(w))) return null;
  for (const word of words) {
    // Variants end at the last `:` outside brackets: `sm:text-lg`, `[&_p]:italic`.
    let depth = 0;
    let cut = 0;
    for (let i = 0; i < word.length; i++) {
      const c = word[i];
      if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === ':' && depth === 0) cut = i + 1;
    }
    const base = word.slice(cut).replace(/^!|!$/g, '');
    if (TEXT_LAYOUT.test(base)) continue;
    if (TEXT_LOOK.test(base)) return word;
  }
  return null;
}

/** The attribute or object key a string is the value of (`href="…"`, `{ color: '…' }`). */
function keyOf(node) {
  let n = node.type === 'TemplateElement' ? node.parent : node;
  if (n.parent?.type === 'JSXExpressionContainer') n = n.parent;
  const p = n.parent;
  if (p?.type === 'JSXAttribute') {
    const name = p.name;
    return name.type === 'JSXNamespacedName'
      ? `${name.namespace.name}:${name.name.name}`
      : name.name;
  }
  if (p?.type === 'Property' && p.value === n && !p.computed) {
    if (p.key.type === 'Identifier') return p.key.name;
    if (p.key.type === 'Literal') return String(p.key.value);
  }
  return undefined;
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
    'no-text-look': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Text looks are Heading, Text, Quote and TextLink from @heisreal/web-ui.',
        },
        schema: [],
        messages: {
          look: 'Use Heading, Text, Quote or TextLink from @heisreal/web-ui instead of the text look `{{word}}` (libs/web-ui/README.md, "Styling order").',
        },
      },
      create: (context) =>
        strings((text, node) => {
          if (
            node.parent?.type === 'ImportDeclaration' ||
            node.parent?.type === 'ImportExpression' ||
            node.parent?.type === 'ExportNamedDeclaration' ||
            node.parent?.type === 'ExportAllDeclaration'
          )
            return;
          const key = keyOf(node);
          if (key !== undefined && NOT_A_COLOUR_KEY.test(key)) return;
          const word = textLook(text);
          if (word) context.report({ node, messageId: 'look', data: { word } });
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
          const what = rawColour(text, keyOf(node));
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
  /** A website's pages: all three checks. */
  pages: [
    {
      files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
      ignores: NOT_PAGES,
      plugins: { '@heisreal/web-ui': plugin },
      rules: {
        '@heisreal/web-ui/field-look': 'error',
        '@heisreal/web-ui/no-raw-colour': 'error',
        '@heisreal/web-ui/no-text-look': 'error',
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
