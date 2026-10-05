# Container image for a NestJS service. Copied into apps/<name>/dist by the
# `copy-dockerfile` Nx target; the build context is the service's
# pruned build output (apps/<name>/dist after `nx run <name>:prune`): the
# webpack bundle plus a trimmed package.json/pnpm-lock.yaml.
#
#   pnpm nx run api-read:container   (builds, prunes and runs docker build)

# --- production dependencies --------------------------------------------------
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY workspace_modules ./workspace_modules
RUN corepack enable \
 && corepack prepare pnpm@11.3.0 --activate \
 && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted

# --- runtime: distroless (no shell, no package manager, non-root) ------------
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY *.js ./
USER nonroot
CMD ["main.js"]
