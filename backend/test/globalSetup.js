import { execSync } from "child_process";
import fs from "fs";

/**
 * Creates a fresh SQLite test database from the Prisma schema before the run.
 */
export default function setup() {
  execSync("npx prisma db push --force-reset --skip-generate", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
  return () => {
    fs.rmSync("test-uploads", { recursive: true, force: true });
  };
}
