import { Contact, Identity } from "../models.js";
import { STAFF_CONTACTS } from "../config.js";

export async function seedContacts() {
  for (const c of STAFF_CONTACTS) {
    await Contact.updateOne({ name: c.name }, { $setOnInsert: c }, { upsert: true });
  }
}

/**
 * Picks the contact with the fewest members. The contact stays with the identity for life,
 * so every loan and every message carries the same name.
 */
export async function pickContact() {
  await seedContacts();
  const contacts = await Contact.find().lean();
  const counts = new Map(
    (await Identity.aggregate([{ $group: { _id: "$contact", n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n])
  );
  contacts.sort((a, b) => (counts.get(String(a._id)) ?? 0) - (counts.get(String(b._id)) ?? 0) || a.name.localeCompare(b.name));
  return contacts[0];
}
