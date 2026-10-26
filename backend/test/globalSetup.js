import fs from "fs";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Starts an in-memory MongoDB for the run. Tests never touch the Atlas cluster.
 */
export default async function setup({ provide }) {
  // First start on Windows can be slow (antivirus scanning the binary).
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 90000, storageEngine: "wiredTiger" } });
  provide("mongoUri", mongod.getUri());
  return async () => {
    await mongod.stop();
    fs.rmSync("test-uploads", { recursive: true, force: true });
  };
}
