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
