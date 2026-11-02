# Container image for a NestJS service. Copied into apps/<name>/dist by the
# `copy-dockerfile` Nx target; the build context is the service's
# pruned build output (apps/<name>/dist after `nx run <name>:prune`): the
# webpack bundle plus a trimmed package.json/pnpm-lock.yaml.
#
#   pnpm nx run api-public-read:container   (builds, prunes and runs docker build)

# --- production dependencies --------------------------------------------------
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY workspace_modules ./workspace_modules
RUN corepack enable \
 && corepack prepare pnpm@11.3.0 --activate \
 && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted

# --- runtime: distroless (no shell, no package manager, non-root) ------------
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:59c479c9b8c123e66047315c968aa2d35e31ae5149c856e4110a79c8b3563f0b
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY *.js ./
USER nonroot
CMD ["main.js"]
