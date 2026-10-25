import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.js"],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "file:./test.db",
      AUTH_RATE_LIMIT: "1000",
      UPLOADS_DIR: "test-uploads",
      SIWE_DOMAIN: "localhost:5173",
      CHAIN_ID: "31337",
      ID_PEPPER: "test-pepper",
      JWT_SECRET: "test-secret",
      IDENTITY_REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    },
  },
});
