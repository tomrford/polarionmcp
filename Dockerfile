FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
  && native="$(find node_modules -path '*/@cloudflare/workerd-linux-*/bin/workerd' -type f | head -n1)" \
  && test -n "$native" \
  && install -D -m 0755 "$native" /opt/workerd/workerd

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/workerd/workerd /usr/local/bin/workerd
COPY --from=build /app/dist /app/dist
COPY --from=build /app/config.capnp /app/config.capnp
WORKDIR /app
ENV PORT=8080 \
    POLARION_GUIDELINES= \
    REST_PAGE_SIZE= \
    FETCH_CONCURRENCY_COUNT= \
    READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES=
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["workerd", "serve", "config.capnp", "--experimental", "--verbose"]
