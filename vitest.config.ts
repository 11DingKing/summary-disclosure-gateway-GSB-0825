import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "file:./test.db",
    },
    globalSetup: ["test/globalSetup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
