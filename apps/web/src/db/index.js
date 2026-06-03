/**
 * Uraiadal Local Database
 * Uses Dexie.js (IndexedDB wrapper)
 * All message content stored encrypted
 */

import Dexie from "dexie";

export const db = new Dexie("UraiadDB");

db.version(1).stores({
  // Identity keypairs
  identity: "id, shortId, createdAt",

  // Contacts (by their public shortId)
  contacts: "id, shortId, name, addedAt",

  // Messages (per chat)
  messages: "++id, chatId, fromId, timestamp, status, type",

  // Double Ratchet session state per contact
  sessions: "contactId, updatedAt",

  // Media metadata (actual blob in R2, key stored here)
  media: "id, messageId, type, size, encryptedKey, url, expiresAt",

  // App settings
  settings: "key",
});

// ── Identity ──────────────────────────────────────────────────────────────

export async function saveIdentity(identity) {
  await db.identity.put({ id: "self", ...identity });
}

export async function getIdentity() {
  return db.identity.get("self");
}

// ── Contacts ──────────────────────────────────────────────────────────────

export async function saveContact(contact) {
  await db.contacts.put({ ...contact, addedAt: Date.now() });
}

export async function getContacts() {
  return db.contacts.orderBy("addedAt").reverse().toArray();
}

export async function getContact(shortId) {
  return db.contacts.get(shortId);
}

export async function deleteContact(shortId) {
  await db.contacts.delete(shortId);
  await db.messages.where("chatId").equals(shortId).delete();
}

// ── Messages ──────────────────────────────────────────────────────────────

export async function saveMessage(msg) {
  return db.messages.put(msg);
}

export async function getMessages(chatId, limit = 50) {
  return db.messages
    .where("chatId").equals(chatId)
    .reverse()
    .limit(limit)
    .toArray()
    .then(msgs => msgs.reverse());
}

export async function updateMessageStatus(id, status) {
  await db.messages.update(id, { status });
}

export async function getLastMessage(chatId) {
  const msgs = await db.messages
    .where("chatId").equals(chatId)
    .reverse()
    .limit(1)
    .toArray();
  return msgs[0] || null;
}

export async function getUnreadCount(chatId) {
  return db.messages
    .where("chatId").equals(chatId)
    .filter(m => m.status !== "read" && m.fromId !== "self")
    .count();
}

export async function markAsRead(chatId) {
  await db.messages
    .where("chatId").equals(chatId)
    .filter(m => m.fromId !== "self")
    .modify({ status: "read" });
}

// ── Sessions (Double Ratchet state) ───────────────────────────────────────

export async function saveSession(contactId, sessionState) {
  await db.sessions.put({ contactId, ...sessionState, updatedAt: Date.now() });
}

export async function getSession(contactId) {
  return db.sessions.get(contactId);
}

// ── Settings ──────────────────────────────────────────────────────────────

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

export async function getSetting(key, defaultValue = null) {
  const row = await db.settings.get(key);
  return row ? row.value : defaultValue;
}

// ── Default settings ──────────────────────────────────────────────────────

export async function initSettings() {
  const defaults = {
    theme:         "dark",
    language:      "en",
    notifications: true,
    soundEnabled:  true,
    mediaAutoLoad: true,
    disappearing:  0, // 0 = off, else seconds
  };
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await getSetting(key);
    if (existing === null) await setSetting(key, value);
  }
}
