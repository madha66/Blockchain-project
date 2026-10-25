import { prisma } from "../db.js";
import { STAFF_CONTACTS } from "../config.js";

export async function seedContacts() {
  for (const c of STAFF_CONTACTS) {
    await prisma.contact.upsert({ where: { name: c.name }, update: {}, create: c });
  }
}

/**
 * Picks the contact with the fewest members. The contact stays with the identity for life,
 * so every loan and every message carries the same name.
 */
export async function pickContact() {
  await seedContacts();
  const contacts = await prisma.contact.findMany({ include: { _count: { select: { identities: true } } } });
  contacts.sort((a, b) => a._count.identities - b._count.identities || a.name.localeCompare(b.name));
  return contacts[0];
}
