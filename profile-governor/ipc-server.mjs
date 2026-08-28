import { profileError } from './errors.mjs';

const METHODS = new Set(['acquire', 'heartbeat', 'renew', 'release', 'externalRelease', 'openTab', 'createFence', 'authorizeFence', 'recordAction', 'transition', 'reconcileProfile', 'recover', 'detectExternalUse', 'getResourceProjection', 'listEvents', 'listRecoveryReceipts']);
const MUTATIONS = new Set(['acquire', 'heartbeat', 'renew', 'release', 'externalRelease', 'openTab', 'createFence', 'authorizeFence', 'recordAction', 'transition', 'reconcileProfile', 'recover', 'detectExternalUse']);

export function createLocalGovernorServer({ service, authenticate } = {}) {
  if (!service) throw new TypeError('service is required');
  const auth = typeof authenticate === 'function' ? authenticate : () => false;
  return {
    networkListener: false,
    async start() { return { transport: 'dependency-injected-local', networkListener: false }; },
    async close() { return { closed: true, networkListener: false }; },
    async call(method, args = {}, { capability } = {}) {
      if (!METHODS.has(method) || typeof service[method] !== 'function') throw profileError('PROFILE_REQUEST_INVALID', 'Unknown Governor local method');
      if (args === null || (typeof args !== 'object' && typeof args !== 'string') || Array.isArray(args)) throw profileError('PROFILE_REQUEST_INVALID', 'Governor local arguments are invalid');
      const external = method.startsWith('external') || args.ownerType === 'external';
      const protectedMethod = MUTATIONS.has(method) || external;
      if (protectedMethod && (!capability || typeof capability !== 'object' || typeof capability.kind !== 'string' || !(await auth(capability)))) throw profileError('PROFILE_IPC_AUTH', 'Authenticated local capability is required');
      if (method === 'recover') return service.recover(args.profileAlias, { authenticatedLocalCapability: true, capability });
      if (method === 'acquire') return service.acquire(args, { authenticatedLocalCapability: true, capability });
      if (method === 'reconcileProfile' || method === 'detectExternalUse' || method === 'getResourceProjection') return service[method](typeof args === 'string' ? args : args.profileAlias);
      return service[method](args);
    },
  };
}
