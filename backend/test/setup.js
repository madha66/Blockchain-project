import { afterAll, beforeAll, inject } from "vitest";
import { connectDb, disconnectDb } from "../src/db.js";

beforeAll(async () => {
  const uri = inject("mongoUri");
  if (!/^mongodb:\/\/127\.0\.0\.1:/.test(uri)) throw new Error("tests must use the in-memory MongoDB");
  await connectDb(uri, "giglend-test");
});

afterAll(disconnectDb);
