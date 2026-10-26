import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.js"],
    setupFiles: ["./test/setup.js"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: "test",
      // Placeholder so dotenv never loads the real cluster URI; setup.js connects to memory.
      MONGODB_URI: "mongodb://127.0.0.1:1/never-used-in-tests",
      MONGODB_DB: "giglend-test",
      AUTH_RATE_LIMIT: "1000",
      UPLOADS_DIR: "test-uploads",
      SIWE_DOMAIN: "localhost:5173",
      CHAIN_ID: "31337",
      ID_ENCRYPTION_KEY: "11".repeat(32),
      ISSUER_PRIVATE_KEY: "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e",
      JWT_SECRET: "test-secret",
      IDENTITY_REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    },
  },
});
