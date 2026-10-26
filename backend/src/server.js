import { createApp } from "./app.js";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { seedContacts } from "./services/contacts.js";
import { createIndexer } from "./services/indexer.js";
import { createWatcher } from "./services/watcher.js";
import { flushQueue, purgeExpired } from "./services/notifier.js";

try {
  await connectDb();
} catch (err) {
  // Only the driver's message: the connection string is never printed.
  console.error(`[giglend-backend] MongoDB connection failed: ${err.message}`);
  process.exit(1);
}

// The indexer also runs as its own process (npm run indexer). INDEXER_IN_PROCESS=false turns
// the in-process copy off so the two do not race.
const indexer = process.env.INDEXER_IN_PROCESS === "false" ? null : createIndexer();
const watcher = createWatcher({ indexer });
const { app } = createApp({ watcher });

await seedContacts();

app.listen(config.port, () => {
  console.log(`[giglend-backend] listening on http://localhost:${config.port}`);
});

// Indexer, then early-warning watcher, then notice queue (contact hours enforced in the notifier).
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    await watcher.tick();
    await flushQueue();
  } catch (err) {
    console.warn("[watcher]", err.shortMessage || err.message);
  } finally {
    running = false;
  }
};
tick();
setInterval(tick, Number(process.env.WATCH_INTERVAL_MS || 15000));
setInterval(() => purgeExpired().catch(() => {}), 24 * 3600 * 1000);
