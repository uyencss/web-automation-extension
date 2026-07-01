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

export async function getProfileInfo(storage = chrome.storage.local) {
  const id = await getOrCreateProfileId(storage);
  let email = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.getProfileUserInfo) {
      const userInfo = await chrome.identity.getProfileUserInfo();
      if (userInfo && userInfo.email) {
        email = userInfo.email;
      }
    }
  } catch (err) {
    // Identity permission might not be granted, or sync is disabled
  }

  const nameData = await storage.get('webmcp_profile_name');
  const name = nameData && nameData.webmcp_profile_name
    ? nameData.webmcp_profile_name
    : (email ? email.split('@')[0] : `Profile-${id.slice(0, 4)}`);

  return { id, email, name };
}
