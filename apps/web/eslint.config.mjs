import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

// D32: Clerk runs in the browser only. Its session cookie reaches web's server incidentally
// (same origin), but web never reads, logs, stores or forwards it, or any request header that
// could carry a token. These rules enforce that in all of web's code.
// A guardrail against honest mistakes, not a security boundary: code review is the other half
// (docs/delivery-status.md, D32). Its probes are in eslint-token-boundary.test.mjs.
const BANNED_MODULES =
  '/^(next\\u002Fheaders|@clerk\\u002F(nextjs|backend))(\\u002F.*)?$/';
const tokenBoundary =
  'D32: web never reads, logs, stores or forwards cookies or tokens';

export default [
  { plugins: { '@next/next': nextEslintPluginNext } },
  ...nx.configs['flat/react-typescript'],
  ...baseConfig,
  {
    ignores: ['.next/**/*', '**/out-tsc'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
    // Specs never ship and may inspect responses; the rules cover everything that runs in web.
    ignores: [
      '**/*.spec.ts',
      '**/*.spec.tsx',
      'eslint-token-boundary.test.mjs',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/headers',
              message: `${tokenBoundary}: no cookies(), headers() or draftMode().`,
            },
            {
              name: '@clerk/nextjs',
              message: `${tokenBoundary}: use @clerk/react in client components.`,
            },
            { name: '@clerk/backend', message: tokenBoundary },
          ],
          patterns: [
            {
              group: ['@clerk/nextjs/*', '@clerk/backend/*'],
              message: tokenBoundary,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // import('next/headers'), import('@clerk/nextjs/server')…
          selector: `ImportExpression[source.value=${BANNED_MODULES}]`,
          message: `${tokenBoundary}: no dynamic import of next/headers or Clerk server SDKs.`,
        },
        {
          selector: `CallExpression[callee.name="require"][arguments.0.value=${BANNED_MODULES}]`,
          message: `${tokenBoundary}: no require of next/headers or Clerk server SDKs.`,
        },
        {
          // x.headers, x.cookies, document.cookie, on any object: request headers can't be read,
          // forwarded or logged. Response headers are set through init objects
          // (`NextResponse.next({ headers: { ... } })`), which this allows.
          selector: 'MemberExpression[property.name=/^(headers|cookies?)$/]',
          message: `${tokenBoundary}: no .headers or .cookies access.`,
        },
        {
          // headers.get('cookie'), cookies.get('__session'), searchParams.get('authorization')…
          selector:
            'CallExpression[callee.property.name=/^(get|getAll|has)$/][arguments.0.value=/^(cookie|authorization|__session|__clerk_db_jwt)$/i]',
          message: `${tokenBoundary}: don't read cookies or tokens.`,
        },
        {
          // fetch(url, options): the options must be an object literal, never a variable
          selector:
            'CallExpression[callee.name="fetch"][arguments.length>1]:not([arguments.1.type="ObjectExpression"])',
          message: `${tokenBoundary}: pass fetch an object literal of options.`,
        },
        {
          // fetch(url, { headers: something }): only literal headers, never forwarded ones
          selector:
            'CallExpression[callee.name="fetch"] > ObjectExpression > Property[key.name="headers"]:not([value.type="ObjectExpression"])',
          message: `${tokenBoundary}: pass fetch an object literal of headers, never forwarded ones.`,
        },
        {
          selector:
            'CallExpression[callee.name="fetch"] > ObjectExpression > SpreadElement',
          message: `${tokenBoundary}: no spread fetch options (they could carry request headers).`,
        },
        {
          selector:
            'CallExpression[callee.name="fetch"] > ObjectExpression > Property[key.name="headers"] > ObjectExpression > SpreadElement',
          message: `${tokenBoundary}: no spread in fetch headers (they could be forwarded ones).`,
        },
      ],
    },
  },
];
