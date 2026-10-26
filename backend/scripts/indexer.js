// Standalone chain indexer: npm run indexer. Run the API with INDEXER_IN_PROCESS=false while
// this is running, so only one indexer writes the mirrors.
import { connectDb, disconnectDb } from "../src/db.js";
import { createIndexer } from "../src/services/indexer.js";

try {
  await connectDb();
} catch (err) {
  console.error(`[indexer] MongoDB connection failed: ${err.message}`);
  process.exit(1);
}

const indexer = createIndexer();
const interval = Number(process.env.INDEXER_INTERVAL_MS || 5000);
let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      const r = await indexer.tick();
      if (r.skipped) console.log(`[indexer] ${r.skipped}`);
      else if (r.indexed || r.reorgedTo !== null || r.notices) {
        console.log(`[indexer] head ${r.head} · +${r.indexed} blocks · notices ${r.notices}`);
      }
    } catch (err) {
      console.warn(`[indexer] ${err.shortMessage || err.message}`);
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  await disconnectDb();
}

process.on("SIGINT", () => {
  stopping = true;
});
loop();
