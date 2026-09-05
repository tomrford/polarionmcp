import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          POLARION_BASE_URL: "https://example.invalid",
          POLARION_GUIDELINES: "",
          REST_PAGE_SIZE: "",
          FETCH_CONCURRENCY_COUNT: "",
          READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES: "",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
