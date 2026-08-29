FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl dumb-init postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile \
    && pnpm --filter @ai-crm/web build

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home app \
    && chown -R app:app /app

USER app

EXPOSE 3000 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "exec", "tsx", "apps/api/src/server.ts"]
