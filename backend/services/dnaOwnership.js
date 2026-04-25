import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-user DNA ownership index.
 *
 * Maps `brandKey` → `mainWallet` (lowercased) so the DNA archive can scope
 * what a connected user sees to their own brands. Without this every user
 * sees every other user's brand DNA, which leaks competitive prompts and
 * makes the /dna page misleading.
 *
 * Schema (JSON object):
 *   {
 *     "<brandKey>": {
 *       "mainWallet": "0x…",
 *       "createdAt": "2026-04-25T18:00:00.000Z"
 *     },
 *     ...
 *   }
 *
 * Backwards compat: brands NOT in this index are treated as public/legacy
 * (they predate the index). New mints from this point forward always
 * register an owner.
 */

const DNA_OWNERS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "dna-owners.json"
);

async function readStore() {
  try {
    const raw = await fs.readFile(DNA_OWNERS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(DNA_OWNERS_PATH), { recursive: true });
  await fs.writeFile(DNA_OWNERS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function normalizeWallet(addr) {
  if (!addr || typeof addr !== "string") return null;
  const trimmed = addr.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/**
 * Register the owner of a brand DNA file. Idempotent — re-calling for the
 * same (brandKey, mainWallet) is a no-op. If the owner already exists and
 * differs from the new caller, the existing record is preserved (DNA
 * files have a single canonical owner — the wallet that first minted).
 */
export async function setDnaOwner(brandKey, mainWalletRaw) {
  const wallet = normalizeWallet(mainWalletRaw);
  if (!brandKey || !wallet) return false;
  const store = await readStore();
  const key = String(brandKey).toLowerCase();
  if (store[key] && store[key].mainWallet) {
    // Existing owner wins — never silently transfer.
    return store[key].mainWallet === wallet;
  }
  store[key] = { mainWallet: wallet, createdAt: new Date().toISOString() };
  await writeStore(store);
  return true;
}

export async function getDnaOwner(brandKey) {
  if (!brandKey) return null;
  const store = await readStore();
  const entry = store[String(brandKey).toLowerCase()];
  return entry?.mainWallet || null;
}

/**
 * Filter a list of {brandKey} items by ownership rules:
 *   - If mainWallet is null/undefined: return everything (no scoping).
 *   - Otherwise: return items where ownership == mainWallet OR no owner
 *     recorded (legacy / pre-index data is treated as public).
 */
export async function filterByOwner(items, mainWalletRaw) {
  const wallet = normalizeWallet(mainWalletRaw);
  if (!wallet) return items;
  const store = await readStore();
  return items.filter((it) => {
    const key = String(it.brandKey || "").toLowerCase();
    const entry = store[key];
    if (!entry || !entry.mainWallet) return true; // legacy / unowned → public
    return entry.mainWallet === wallet;
  });
}

export async function isOwnedBy(brandKey, mainWalletRaw) {
  const wallet = normalizeWallet(mainWalletRaw);
  if (!wallet) return false;
  const owner = await getDnaOwner(brandKey);
  if (!owner) return true; // legacy / unowned → readable to anyone
  return owner === wallet;
}
