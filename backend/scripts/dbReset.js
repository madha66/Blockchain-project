// npm run db:reset: drops every GigLend collection in MONGODB_DB (after redeploying contracts).
import mongoose from "mongoose";
import { connectDb, disconnectDb } from "../src/db.js";
import { config } from "../src/config.js";

try {
  await connectDb();
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.syncIndexes();
  console.log(`reset database ${config.mongoDb}`);
} catch (err) {
  console.log(String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
