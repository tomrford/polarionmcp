FROM denoland/deno:2.7.14
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends webp \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN deno cache src/main.ts
ENV PORT=8080
EXPOSE 8080
CMD ["deno", "task", "start"]
