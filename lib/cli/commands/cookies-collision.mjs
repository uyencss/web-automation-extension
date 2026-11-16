/**
 * Check if candidate cookies collide with cookies already present on the target profile.
 * Fail before mutation policy (MVP): any collision throws COLLISION_DETECTED.
 */
export function checkTargetCollisions(candidateCookies, targetCookies, urlHostname) {
  for (const candidate of candidateCookies) {
    const candName = candidate.name;
    const candPath = candidate.path || '/';
    const candDomain = (candidate.domain || urlHostname).toLowerCase().replace(/^\./, '');

    for (const existing of targetCookies) {
      const existName = existing.name;
      const existPath = existing.path || '/';
      const existDomain = (existing.domain || urlHostname).toLowerCase().replace(/^\./, '');

      if (candName === existName && candPath === existPath && candDomain === existDomain) {
        const err = new Error(`COLLISION_DETECTED: Cookie '${candName}' already exists on target profile for domain '${candDomain}' path '${candPath}'`);
        err.code = 'COLLISION_DETECTED';
        throw err;
      }
    }
  }
}
