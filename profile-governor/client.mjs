export class GovernorClient {
  constructor({ server, capability } = {}) {
    if (!server || typeof server.call !== 'function') throw new TypeError('local Governor server is required');
    this.server = server;
    this.capability = capability;
  }

  call(method, args = {}) { return this.server.call(method, args, { capability: this.capability }); }
  acquire(request) { return this.call('acquire', request); }
  heartbeat(input) { return this.call('heartbeat', input); }
  renew(input) { return this.call('renew', input); }
  release(input) { return this.call('release', input); }
  externalRelease(input) { return this.call('externalRelease', input); }
  openTab(input) { return this.call('openTab', input); }
  createFence(input) { return this.call('createFence', input); }
  authorizeFence(input) { return this.call('authorizeFence', input); }
  recordAction(input) { return this.call('recordAction', input); }
  transition(input) { return this.call('transition', input); }
  reconcileProfile(alias) { return this.call('reconcileProfile', { profileAlias: alias }); }
  recover(alias) { return this.call('recover', { profileAlias: alias }); }
  detectExternalUse(alias) { return this.call('detectExternalUse', { profileAlias: alias }); }
  getResourceProjection(alias) { return this.call('getResourceProjection', { profileAlias: alias }); }
  listEvents() { return this.call('listEvents'); }
  listRecoveryReceipts() { return this.call('listRecoveryReceipts'); }
}

export const createGovernorClient = (options) => new GovernorClient(options);
