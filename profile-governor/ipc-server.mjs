import { profileError } from './errors.mjs';

const METHODS = new Set(['acquire', 'heartbeat', 'renew', 'release', 'externalRelease', 'openTab', 'createFence', 'authorizeFence', 'recordAction', 'transition', 'reconcileProfile', 'recover', 'detectExternalUse', 'getResourceProjection', 'listEvents', 'listRecoveryReceipts']);
const EMPTY_ARGS = new Set(['listEvents', 'listRecoveryReceipts']);
const PROFILE_ARGS = new Set(['reconcileProfile', 'recover', 'detectExternalUse', 'getResourceProjection']);

function validateArgs(method, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw profileError('PROFILE_REQUEST_INVALID', 'Governor local arguments are invalid');
  if (EMPTY_ARGS.has(method) && Object.keys(args).length !== 0) throw profileError('PROFILE_REQUEST_INVALID', 'Governor local method takes no arguments');
  if (PROFILE_ARGS.has(method) && (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'profileAlias'))) throw profileError('PROFILE_REQUEST_INVALID', 'Governor local profile arguments are invalid');
  return args;
}

export function createLocalGovernorServer({ service, authenticate } = {}) {
  if (!service) throw new TypeError('service is required');
  const auth = typeof authenticate === 'function' ? authenticate : () => false;
  return {
    networkListener: false,
    async start() { return { transport: 'dependency-injected-local', networkListener: false }; },
    async close() { return { closed: true, networkListener: false }; },
    async call(method, args = {}, { capability } = {}) {
      if (!METHODS.has(method) || typeof service[method] !== 'function') throw profileError('PROFILE_REQUEST_INVALID', 'Unknown Governor local method');
      let authenticated = false;
      if (capability && typeof capability === 'object' && !Array.isArray(capability) && typeof capability.kind === 'string') {
        try { authenticated = (await auth(capability)) === true; } catch { authenticated = false; }
      }
      if (!authenticated) throw profileError('PROFILE_IPC_AUTH', 'Authenticated local capability is required');
      validateArgs(method, args);
      if (method === 'recover') return service.recover(args.profileAlias, { authenticatedLocalCapability: true, capability });
      if (method === 'acquire') return service.acquire(args, { authenticatedLocalCapability: true, capability });
      if (method === 'reconcileProfile' || method === 'detectExternalUse' || method === 'getResourceProjection') return service[method](args.profileAlias);
      if (EMPTY_ARGS.has(method)) return service[method]();
      return service[method](args);
    },
  };
}
