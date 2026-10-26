// npm run db:ping prints "connected" or the error message only (never the URI).
import mongoose from "mongoose";
import { config } from "../src/config.js";

try {
  if (!config.mongoUri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(config.mongoUri, { dbName: config.mongoDb, serverSelectionTimeoutMS: 10000 });
  await mongoose.connection.db.admin().ping();
  console.log("connected");
  await mongoose.disconnect();
} catch (err) {
  console.log(String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exitCode = 1;
}
