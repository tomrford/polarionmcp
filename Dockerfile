FROM denoland/deno:2.6.10
WORKDIR /app
COPY . .
RUN deno cache --allow-env --allow-net --allow-read src/server.ts
ENV PORT=8080
EXPOSE 8080
CMD ["deno", "task", "start"]
