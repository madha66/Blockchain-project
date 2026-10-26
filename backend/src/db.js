import mongoose from "mongoose";
import { config } from "./config.js";

mongoose.set("strictQuery", true);

/**
 * Connects to MongoDB (Atlas or the in-memory server in tests). The URI is never logged.
 */
export async function connectDb(uri = config.mongoUri, dbName = config.mongoDb) {
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000 });
  await mongoose.connection.syncIndexes();
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
