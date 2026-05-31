FROM denoland/deno:2.7.14
WORKDIR /app
COPY . .
RUN deno cache src/main.ts
ENV PORT=8080
EXPOSE 8080
CMD ["deno", "task", "start"]
