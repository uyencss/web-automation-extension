import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SAFE_BOOTSTRAP_ID,
  getWebmcpHome,
  readJsonFile,
} from '../../context.mjs';

function profileIdFromDispatcherEntry(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.profileId ?? entry.id;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function normalizedReviewDecision(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';
  const raw = entry.decision ?? entry.reviewDecision ?? entry.review?.decision ?? entry.status;
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  if (['approved', 'allow', 'allowed', 'reviewed', 'accepted'].includes(value)) return 'approved';
  if (['rejected', 'deny', 'denied', 'blocked'].includes(value)) return 'rejected';
  if (['pending', 'todo', 'unreviewed', 'needs-review'].includes(value)) return 'pending';
  return 'other';
}

function summarizeDispatcherProfiles(rawProfiles) {
  const profiles = rawProfiles && typeof rawProfiles === 'object' && !Array.isArray(rawProfiles)
    ? rawProfiles
    : {};
  const decisions = { approved: 0, rejected: 0, pending: 0, other: 0, unknown: 0 };
  const trustDomains = new Set();
  const physicalRefs = new Map();
  let stringEntries = 0;
  let objectEntries = 0;
  let invalidEntries = 0;
  let missingProfileId = 0;
  let missingTrustDomain = 0;

  for (const [alias, entry] of Object.entries(profiles)) {
    const profileId = profileIdFromDispatcherEntry(entry);
    if (typeof entry === 'string') {
      stringEntries += 1;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      objectEntries += 1;
      decisions[normalizedReviewDecision(entry)] += 1;
      const trustDomain = typeof entry.trustDomain === 'string' ? entry.trustDomain.trim() : '';
      if (trustDomain) trustDomains.add(trustDomain);
      else missingTrustDomain += 1;
      const physicalRef = entry.physicalProfileHash ?? entry.profileHash ?? entry.physicalProfileIdHash;
      if (typeof physicalRef === 'string' && physicalRef.trim()) {
        const key = physicalRef.trim();
        physicalRefs.set(key, (physicalRefs.get(key) || 0) + 1);
      }
    } else {
      invalidEntries += 1;
    }
    if (!profileId) missingProfileId += 1;
    if (typeof alias !== 'string' || !alias.trim()) invalidEntries += 1;
  }

  const physicalGroupSizes = [...physicalRefs.values()];
  return {
    profileAliases: Object.keys(profiles).length,
    stringEntries,
    objectEntries,
    invalidEntries,
    missingProfileId,
    decisions,
    trustDomains: {
      count: trustDomains.size,
      missing: missingTrustDomain,
    },
    physicalProfiles: {
      hashedEntries: physicalGroupSizes.reduce((sum, size) => sum + size, 0),
      distinctGroups: physicalGroupSizes.length,
      sharedGroups: physicalGroupSizes.filter((size) => size > 1).length,
      largestGroupSize: physicalGroupSizes.length ? Math.max(...physicalGroupSizes) : 0,
    },
  };
}

function summarizeDispatcherGatewayProfiles(rawGateways) {
  const gateways = rawGateways && typeof rawGateways === 'object' && !Array.isArray(rawGateways)
    ? rawGateways
    : {};
  const aggregate = {
    profileAliases: 0,
    stringEntries: 0,
    objectEntries: 0,
    invalidEntries: 0,
    missingProfileId: 0,
    decisions: { approved: 0, rejected: 0, pending: 0, other: 0, unknown: 0 },
    trustDomains: { count: 0, missing: 0 },
    physicalProfiles: { hashedEntries: 0, distinctGroups: 0, sharedGroups: 0, largestGroupSize: 0 },
  };
  const trustDomains = new Set();
  const physicalRefs = new Map();

  for (const gateway of Object.values(gateways)) {
    const summary = summarizeDispatcherProfiles(gateway?.profiles);
    aggregate.profileAliases += summary.profileAliases;
    aggregate.stringEntries += summary.stringEntries;
    aggregate.objectEntries += summary.objectEntries;
    aggregate.invalidEntries += summary.invalidEntries;
    aggregate.missingProfileId += summary.missingProfileId;
    for (const [key, value] of Object.entries(summary.decisions)) aggregate.decisions[key] += value;
    aggregate.trustDomains.missing += summary.trustDomains.missing;
    aggregate.physicalProfiles.hashedEntries += summary.physicalProfiles.hashedEntries;
    aggregate.physicalProfiles.sharedGroups += summary.physicalProfiles.sharedGroups;
    aggregate.physicalProfiles.largestGroupSize = Math.max(
      aggregate.physicalProfiles.largestGroupSize,
      summary.physicalProfiles.largestGroupSize,
    );

    const profiles = gateway?.profiles && typeof gateway.profiles === 'object' && !Array.isArray(gateway.profiles)
      ? gateway.profiles
      : {};
    for (const entry of Object.values(profiles)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const trustDomain = typeof entry.trustDomain === 'string' ? entry.trustDomain.trim() : '';
      if (trustDomain) trustDomains.add(trustDomain);
      const physicalRef = entry.physicalProfileHash ?? entry.profileHash ?? entry.physicalProfileIdHash;
      if (typeof physicalRef === 'string' && physicalRef.trim()) {
        const key = physicalRef.trim();
        physicalRefs.set(key, (physicalRefs.get(key) || 0) + 1);
      }
    }
  }

  const physicalGroupSizes = [...physicalRefs.values()];
  aggregate.trustDomains.count = trustDomains.size;
  aggregate.physicalProfiles.distinctGroups = physicalGroupSizes.length;
  if (physicalGroupSizes.length) {
    aggregate.physicalProfiles.sharedGroups = physicalGroupSizes.filter((size) => size > 1).length;
    aggregate.physicalProfiles.largestGroupSize = Math.max(...physicalGroupSizes);
  }
  return aggregate;
}

function summarizeProfileBindings(rawBindings) {
  const bindings = rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)
    ? rawBindings
    : {};
  const decisions = { approved: 0, rejected: 0, pending: 0, other: 0, unknown: 0 };
  let missingGateway = 0;
  let missingProfileAlias = 0;
  let withCredentialRefs = 0;
  let withSiteAccountRef = 0;
  let withProfileIdentityRef = 0;
  let runStagingDownloads = 0;
  let boundedReauth = 0;

  for (const binding of Object.values(bindings)) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      decisions.unknown += 1;
      missingGateway += 1;
      missingProfileAlias += 1;
      continue;
    }
    decisions[normalizedReviewDecision(binding)] += 1;
    if (typeof binding.gateway !== 'string' || !binding.gateway.trim()) missingGateway += 1;
    if (typeof binding.profileAlias !== 'string' || !binding.profileAlias.trim()) missingProfileAlias += 1;
    if (binding.credentialRefs && typeof binding.credentialRefs === 'object' && !Array.isArray(binding.credentialRefs)) {
      withCredentialRefs += 1;
    }
    if (typeof binding.siteAccountRef === 'string' && binding.siteAccountRef.trim()) withSiteAccountRef += 1;
    if (typeof binding.profileIdentityRef === 'string' && binding.profileIdentityRef.trim()) withProfileIdentityRef += 1;
    if (binding.downloadPolicy === 'run-staging') runStagingDownloads += 1;
    if (typeof binding.reauthPolicy === 'string' && binding.reauthPolicy !== 'manual' && binding.reauthPolicy !== 'disabled') {
      boundedReauth += 1;
    }
  }

  return {
    count: Object.keys(bindings).length,
    missingGateway,
    missingProfileAlias,
    decisions,
    withCredentialRefs,
    withSiteAccountRef,
    withProfileIdentityRef,
    runStagingDownloads,
    boundedReauth,
  };
}

export function readDispatcherReadiness() {
  const file = resolve(getWebmcpHome(), 'dispatcher.config.json');
  if (!existsSync(file)) {
    return {
      schema: 'webmcp-dispatcher-readiness/1',
      configured: false,
      readable: false,
      path: file,
      warning: 'dispatcher.config.json not found',
    };
  }

  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    return {
      schema: 'webmcp-dispatcher-readiness/1',
      configured: true,
      readable: false,
      path: file,
      error: parsed.error,
    };
  }

  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  const gateways = data.gateways && typeof data.gateways === 'object' && !Array.isArray(data.gateways)
    ? data.gateways
    : {};
  return {
    schema: 'webmcp-dispatcher-readiness/1',
    configured: true,
    readable: true,
    path: file,
    configSchema: typeof data.schema === 'string' ? data.schema : null,
    defaultGatewayConfigured: typeof data.defaultGateway === 'string' && Boolean(data.defaultGateway.trim()),
    gatewayCount: Object.keys(gateways).length,
    profiles: data.profiles
      ? summarizeDispatcherProfiles(data.profiles)
      : summarizeDispatcherGatewayProfiles(gateways),
    profileBindings: summarizeProfileBindings(data.profileBindings),
  };
}

export function dispatcherConfigPath() {
  return resolve(getWebmcpHome(), 'dispatcher.config.json');
}

export function readDispatcherConfigForWrite() {
  const file = dispatcherConfigPath();
  if (!existsSync(file)) {
    throw new Error('dispatcher.config.json not found');
  }
  const parsed = readJsonFile(file);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error(`dispatcher.config.json is not a JSON object: ${parsed.error || 'invalid JSON'}`);
  }
  return { file, config: parsed.data };
}

export function safeBootstrapId(value, name) {
  if (typeof value !== 'string' || !SAFE_BOOTSTRAP_ID.test(value)) {
    throw new Error(`${name} must be a safe id`);
  }
  return value;
}

export function maybeSafeBootstrapId(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return safeBootstrapId(value, name);
}

export function safeBootstrapProfileId(value, name) {
  if (typeof value !== 'string'
    || value.length < 2
    || value.length > 160
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.includes('\\\\')) {
    throw new Error(`${name} must be a safe profile id`);
  }
  return value;
}
