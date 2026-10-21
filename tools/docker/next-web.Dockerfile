# Container image for the Next.js site (apps/web). The build context is
# apps/web/dist, assembled by `nx run web:prune` from Next's standalone output
# (.next/standalone: server.js plus only the node_modules it traced) with the
# static assets beside it. Nothing is installed here: same distroless runtime
# as the NestJS services (nest-service.Dockerfile).
#
#   pnpm nx run web:container   (builds, assembles apps/web/dist and runs docker build)

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080
# Root-owned and read-only to the server: no ISR or image cache is written yet.
COPY node_modules ./node_modules
COPY apps ./apps
WORKDIR /app/apps/web
USER nonroot
CMD ["server.js"]
