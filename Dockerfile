FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    STATIC_DIR=/app/apps/web/dist \
    EIGHTCARDS_MIGRATIONS_DIR=/app/apps/server/migrations
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=app:app /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=app:app /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=app:app /app/apps/server/migrations ./apps/server/migrations
COPY --from=build --chown=app:app /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=app:app /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=app:app /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=app:app /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=app:app /app/packages/game-engine/package.json ./packages/game-engine/package.json
COPY --from=build --chown=app:app /app/packages/game-engine/node_modules ./packages/game-engine/node_modules
COPY --from=build --chown=app:app /app/packages/game-engine/dist ./packages/game-engine/dist
COPY --chown=app:app scripts ./scripts
RUN chmod 0555 /app/scripts/*.sh
USER app
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
