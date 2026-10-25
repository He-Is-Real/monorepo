// Regression probes for web's token boundary (D32, apps/web/eslint.config.mjs), from #44's
// reviews: each forbidden pattern must give a no-restricted-* error, and the patterns web needs
// must stay clean. Run by the `lint` target (`lint-rules`). The rules are a guardrail against
// honest mistakes, not a security boundary: code review is the other half.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: dirname(fileURLToPath(import.meta.url)) });

async function restricted(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((m) => m.ruleId?.startsWith('no-restricted-'))
    .map((m) => m.message);
}

const ROUTE = 'src/app/probe/route.ts';
const PROXY = 'src/proxy.ts';
const MIDDLEWARE = 'src/middleware.ts';
const PAGE = 'src/app/probe/page.tsx';
// The one carve-out (M2): the browser-only api-user client may build request headers and read
// response headers, and nothing else is relaxed there.
const API_USER_CLIENT = 'src/lib/api-user.ts';
const CLIENT_CALL = `const h = new Headers(); h.set('Authorization', 'Bearer t'); export const call = async () => { const r = await fetch('https://api-user.example/v1/account', { headers: h }); return r.headers.get('ETag'); };`;

const forbidden = [
  [
    'static import of next/headers',
    ROUTE,
    `import { cookies } from 'next/headers'; export const x = cookies;`,
  ],
  [
    '@clerk/nextjs/server',
    ROUTE,
    `import { auth } from '@clerk/nextjs/server'; export const x = auth;`,
  ],
  [
    '@clerk/backend',
    PROXY,
    `import { verifyToken } from '@clerk/backend'; export const x = verifyToken;`,
  ],
  [
    'dynamic import of next/headers',
    ROUTE,
    `export async function GET() { const h = await import('next/headers'); return Response.json(h); }`,
  ],
  [
    'dynamic import of a Clerk server SDK',
    MIDDLEWARE,
    `export async function middleware() { return import('@clerk/nextjs/server'); }`,
  ],
  [
    'require of next/headers',
    ROUTE,
    `const h = require('next/headers'); export default h;`,
  ],
  [
    'headers of a parameter with any name',
    ROUTE,
    `export function GET(incoming: Request) { return Response.json([...incoming.headers]); }`,
  ],
  [
    'headers in the proxy',
    PROXY,
    `export function proxy(r: Request) { const h = r.headers; return h; }`,
  ],
  [
    'cookies of a NextRequest',
    MIDDLEWARE,
    `export function middleware(r: { cookies: unknown }) { return r.cookies; }`,
  ],
  ['document.cookie', PAGE, `export const c = () => document.cookie;`],
  [
    'reading a token by name',
    PAGE,
    `export const t = (m: Map<string, string>) => m.get('__session');`,
  ],
  [
    'fetch options in a variable',
    ROUTE,
    `export async function GET() { const init = { method: 'GET' }; return fetch('https://api.example', init); }`,
  ],
  [
    'fetch headers in a variable',
    ROUTE,
    `export async function GET() { const h = { a: 'b' }; return fetch('https://api.example', { headers: h }); }`,
  ],
  [
    'spread fetch options',
    ROUTE,
    `export async function GET() { const o = {}; return fetch('https://api.example', { ...o }); }`,
  ],
  [
    'spread into fetch headers',
    ROUTE,
    `export async function GET() { const h = {}; return fetch('https://api.example', { headers: { ...h, accept: 'x' } }); }`,
  ],
  [
    'the api-user client’s headers anywhere but its own file',
    'src/lib/other-client.ts',
    CLIENT_CALL,
  ],
  [
    'the api-user client’s headers in a component',
    'src/components/probe.tsx',
    CLIENT_CALL,
  ],
  [
    'next/headers in the api-user client',
    API_USER_CLIENT,
    `export const x = () => import('next/headers');`,
  ],
  [
    'cookies in the api-user client',
    API_USER_CLIENT,
    `export const c = () => document.cookie;`,
  ],
  [
    'reading a token by name in the api-user client',
    API_USER_CLIENT,
    `export const t = (h: Headers) => h.get('authorization');`,
  ],
];

const allowed = [
  [
    'a literal fetch with literal headers (server render from api-public-read)',
    ROUTE,
    `export async function GET() { return fetch('https://api.example/v1/stories/x', { headers: { accept: 'application/json' }, cache: 'no-store' }); }`,
  ],
  [
    'the browser sending its own token (M2)',
    'src/components/probe.tsx',
    `'use client';\nexport const call = (token: string) => fetch('https://api-user.example/v1/account', { headers: { Authorization: \`Bearer \${token}\` } });`,
  ],
  [
    'response headers through an init object',
    PROXY,
    `import { NextResponse } from 'next/server';\nexport function proxy() { return NextResponse.next({ headers: { 'X-Robots-Tag': 'noindex, nofollow' } }); }`,
  ],
  [
    'the api-user client building its headers and reading ETag (the carve-out)',
    API_USER_CLIENT,
    `'use client';\n${CLIENT_CALL}`,
  ],
  [
    'a fetch with only a URL',
    ROUTE,
    `export async function GET() { return fetch('https://api.example'); }`,
  ],
];

describe('web token boundary (D32)', () => {
  for (const [name, path, code] of forbidden) {
    it(`refuses ${name}`, async () => {
      const messages = await restricted(code, path);
      assert.ok(messages.length > 0, `no diagnostic for: ${code}`);
      assert.ok(
        messages.every((m) => m.includes('D32')),
        messages.join('\n'),
      );
    });
  }
  for (const [name, path, code] of allowed) {
    it(`allows ${name}`, async () => {
      assert.deepEqual(await restricted(code, path), []);
    });
  }
});
