FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
  && native="$(node -p 'require.resolve("workerd/bin/workerd")')" \
  && install -D -m 0755 "$native" /opt/workerd/workerd

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/workerd/workerd /usr/local/bin/workerd
COPY --from=build /app/dist /app/dist
COPY --from=build /app/src/serve.mjs /app/serve.mjs
WORKDIR /app
ENV WORKERD_BINARY=/usr/local/bin/workerd \
    PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8080}/readyz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "serve.mjs"]
