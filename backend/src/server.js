import { createApp } from "./app.js";
import { config } from "./config.js";
import { seedContacts } from "./services/contacts.js";
import { createWatcher } from "./services/watcher.js";
import { flushQueue, purgeExpired } from "./services/notifier.js";

const watcher = createWatcher();
const { app } = createApp({ watcher });

await seedContacts();

app.listen(config.port, () => {
  console.log(`[giglend-backend] listening on http://localhost:${config.port}`);
});

// Early-warning watcher and notice queue (contact hours enforced in the notifier).
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
