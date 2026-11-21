//@ts-check
const { join } = require('node:path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server (.next/standalone) for the Cloud Run image
  // (tools/docker/next-web.Dockerfile). Tracing starts at the workspace root
  // so pnpm's hoisted packages are included.
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../..'),
  poweredByHeader: false,
  // Don't write AGENTS.md / CLAUDE.md into apps/web on `next dev` (the repo's own AGENTS.md
  // applies; .gitignore backstops this).
  agentRules: false,
  reactStrictMode: true,
  // Page caching (Joel, 2026-11-21; src/lib/page-cache.ts, src/page-cache.config.ts): Next's own
  // `'use cache'`, kept in this server's memory. Every page still renders per request (the root
  // layout's `connection()`), so nothing is saved at build time.
  cacheComponents: true,
  partialPrefetching: true,
  // The most the saved pages take in each server's memory (512 MiB on Cloud Run): least recently
  // used first out. Next's default, written down.
  cacheMaxMemorySize: 50 * 1024 * 1024,
  // The mockups call browse "browse.html"; the page lives at /stories (M1 step 6b-1).
  async redirects() {
    return [{ source: '/browse', destination: '/stories', permanent: true }];
  },
  images: {
    // No runtime image optimiser (and no sharp) on Cloud Run: our own assets
    // are pre-sized, and story media will come from Bunny.net's CDN.
    unoptimized: true,
  },
  // ...so leave sharp and libvips (about 19 MB) out of the standalone server.
  outputFileTracingExcludes: {
    '*': [
      '../../node_modules/.pnpm/sharp@*/**',
      '../../node_modules/.pnpm/@img+*/**',
    ],
  },
};

module.exports = nextConfig;
