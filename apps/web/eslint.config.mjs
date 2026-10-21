import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

// D32: Clerk runs in the browser only. Its session cookie reaches web's server incidentally
// (same origin), but web never reads, logs, stores or forwards it, or any request header that
// could carry a token. These rules enforce that in all of web's code.
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
          // request.cookies, document.cookie, cookieStore…
          selector: 'MemberExpression[property.name=/^cookies?$/]',
          message: `${tokenBoundary}: don't touch cookies.`,
        },
        {
          // request.headers / req.headers in route handlers and the proxy
          selector:
            'MemberExpression[object.name=/^req(uest)?$/][property.name="headers"]',
          message: `${tokenBoundary}: don't read request headers.`,
        },
        {
          // headers.get('cookie'), cookies.get('__session'), searchParams.get('authorization')…
          selector:
            'CallExpression[callee.property.name=/^(get|getAll|has)$/][arguments.0.value=/^(cookie|authorization|__session|__clerk_db_jwt)$/i]',
          message: `${tokenBoundary}: don't read cookies or tokens.`,
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
      ],
    },
  },
];
