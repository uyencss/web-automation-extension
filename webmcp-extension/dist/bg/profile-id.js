// Stable per-Chrome-profile identifier.
//
// chrome.storage.local is isolated per Chrome profile, so persisting a
// generated UUID here yields a unique, stable id per profile with zero
// per-profile configuration. The gateway uses this id to route /api commands
// to the correct browser connection when multiple profiles are connected.

const STORAGE_KEY = 'webmcp_profile_id';

export async function getOrCreateProfileId(
  storage = chrome.storage.local,
  generateId = () => crypto.randomUUID(),
) {
  const existing = await storage.get(STORAGE_KEY);
  if (existing && existing[STORAGE_KEY]) {
    return existing[STORAGE_KEY];
  }
  const id = generateId();
  await storage.set({ [STORAGE_KEY]: id });
  return id;
}
