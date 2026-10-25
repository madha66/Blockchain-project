import { createApp } from "./app.js";
import { config } from "./config.js";
import { seedContacts } from "./services/contacts.js";

const { app } = createApp();

await seedContacts();

app.listen(config.port, () => {
  console.log(`[giglend-backend] listening on http://localhost:${config.port}`);
});
