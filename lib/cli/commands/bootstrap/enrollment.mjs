import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BOOTSTRAP_BINDING_DECISIONS,
  BOOTSTRAP_NODE_ROLES,
  BOOTSTRAP_REAUTH_POLICIES,
  parseFlags,
} from '../../context.mjs';
import { getChromeLauncher } from '../../component-resolver.mjs';
import {
  maybeSafeBootstrapId,
  readDispatcherConfigForWrite,
  safeBootstrapId,
  safeBootstrapProfileId,
} from './config-readiness.mjs';
import { writeBootstrapEnrollmentReceipt } from './receipts.mjs';
import {
  expectedServiceIdsForRole,
  machineRoleConfigPath,
} from './services.mjs';

export function buildBindingEnrollment(args) {
  const { flags } = parseFlags(args);
  const id = safeBootstrapId(flags.id, 'id');
  const gateway = safeBootstrapId(flags.gateway, 'gateway');
  const profileAlias = safeBootstrapId(flags['profile-alias'], 'profile-alias');
  const decision = flags.decision ?? 'pending';
  if (!BOOTSTRAP_BINDING_DECISIONS.has(decision)) {
    throw new Error('decision must be approved, pending, or rejected');
  }
  const reauthPolicy = flags['reauth-policy'] ?? 'manual';
  if (!BOOTSTRAP_REAUTH_POLICIES.has(reauthPolicy)) {
    throw new Error('reauth-policy must be manual, disabled, or bounded-one-attempt');
  }
  const credentialPurposeRef = maybeSafeBootstrapId(flags['credential-purpose-ref'], 'credential-purpose-ref');
  const siteAccountRef = maybeSafeBootstrapId(flags['site-account-ref'], 'site-account-ref');
  const profileIdentityRef = maybeSafeBootstrapId(flags['profile-identity-ref'], 'profile-identity-ref');
  const downloadPolicy = flags['download-policy'] ?? null;
  if (downloadPolicy !== null && !['manual', 'run-staging'].includes(downloadPolicy)) {
    throw new Error('download-policy must be manual or run-staging');
  }
  const apply = Boolean(flags.yes);
  const { file, config } = readDispatcherConfigForWrite();
  const gateways = config.gateways && typeof config.gateways === 'object' && !Array.isArray(config.gateways)
    ? config.gateways
    : {};
  if (!gateways[gateway]) throw new Error(`gateway ${gateway} is not declared`);
  const gatewayProfiles = gateways[gateway]?.profiles && typeof gateways[gateway].profiles === 'object' && !Array.isArray(gateways[gateway].profiles)
    ? gateways[gateway].profiles
    : {};
  const topProfiles = config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles)
    ? config.profiles
    : {};
  if (!Object.hasOwn(gatewayProfiles, profileAlias) && !Object.hasOwn(topProfiles, profileAlias)) {
    throw new Error(`profile alias ${profileAlias} is not declared`);
  }

  const binding = {
    gateway,
    profileAlias,
    decision,
    reauthPolicy,
  };
  if (downloadPolicy) binding.downloadPolicy = downloadPolicy;
  if (credentialPurposeRef) binding.credentialRefs = { login: credentialPurposeRef };
  if (siteAccountRef) binding.siteAccountRef = siteAccountRef;
  if (profileIdentityRef) binding.profileIdentityRef = profileIdentityRef;

  let receipt = null;
  if (apply) {
    const next = {
      ...config,
      profileBindings: {
        ...(config.profileBindings && typeof config.profileBindings === 'object' && !Array.isArray(config.profileBindings)
          ? config.profileBindings
          : {}),
        [id]: binding,
      },
    };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    receipt = writeBootstrapEnrollmentReceipt('binding', id, {
      id,
      gateway,
      profileAlias,
      decision,
      reauthPolicy,
      reauthReady: reauthPolicy !== 'manual' && reauthPolicy !== 'disabled' && Boolean(credentialPurposeRef),
      hasCredentialRef: Boolean(credentialPurposeRef),
      hasSiteAccountRef: Boolean(siteAccountRef),
      hasProfileIdentityRef: Boolean(profileIdentityRef),
      downloadPolicy: downloadPolicy || null,
    });
  }

  return {
    schema: 'webmcp-bootstrap-binding-enrollment/1',
    version: 1,
    applied: apply,
    redacted: true,
    dispatcherConfigured: true,
    binding: {
      id,
      gateway,
      profileAlias,
      decision,
      reauthReady: reauthPolicy !== 'manual' && reauthPolicy !== 'disabled' && Boolean(credentialPurposeRef),
      hasCredentialRef: Boolean(credentialPurposeRef),
      hasSiteAccountRef: Boolean(siteAccountRef),
      hasProfileIdentityRef: Boolean(profileIdentityRef),
      downloadPolicy: downloadPolicy || null,
    },
    receipt,
    next: apply
      ? 'Re-run webmcp bootstrap canary --json to verify the binding blockers.'
      : 'Re-run with --yes to write the reviewed profile binding metadata.',
  };
}

export function buildAliasEnrollment(args) {
  const { flags } = parseFlags(args);
  const gateway = safeBootstrapId(flags.gateway, 'gateway');
  const alias = safeBootstrapId(flags.alias, 'alias');
  const candidateOrdinal = flags['candidate-ordinal'] === undefined ? null : Number(flags['candidate-ordinal']);
  if (candidateOrdinal !== null && (!Number.isInteger(candidateOrdinal) || candidateOrdinal < 1 || candidateOrdinal > 999)) {
    throw new Error('candidate-ordinal must be a positive integer');
  }
  if (flags['profile-id'] && candidateOrdinal !== null) {
    throw new Error('use either profile-id or candidate-ordinal, not both');
  }
  let profileId = flags['profile-id'] ? safeBootstrapProfileId(flags['profile-id'], 'profile-id') : null;
  if (!profileId && candidateOrdinal !== null) {
    const { listAllProfiles } = getChromeLauncher();
    const profiles = listAllProfiles();
    const candidates = [...(profiles.managed || []), ...(profiles.existing || [])];
    const candidate = candidates[candidateOrdinal - 1];
    if (!candidate?.id) throw new Error(`candidate ordinal ${candidateOrdinal} is not available`);
    profileId = safeBootstrapProfileId(candidate.id, 'candidate profile id');
  }
  if (!profileId) throw new Error('profile-id or candidate-ordinal is required');
  const apply = Boolean(flags.yes);
  const { file, config } = readDispatcherConfigForWrite();
  const gateways = config.gateways && typeof config.gateways === 'object' && !Array.isArray(config.gateways)
    ? config.gateways
    : {};
  if (!gateways[gateway]) throw new Error(`gateway ${gateway} is not declared`);
  const gatewayConfig = gateways[gateway] && typeof gateways[gateway] === 'object' && !Array.isArray(gateways[gateway])
    ? gateways[gateway]
    : {};
  const profiles = gatewayConfig.profiles && typeof gatewayConfig.profiles === 'object' && !Array.isArray(gatewayConfig.profiles)
    ? gatewayConfig.profiles
    : {};

  let receipt = null;
  if (apply) {
    const next = {
      ...config,
      gateways: {
        ...gateways,
        [gateway]: {
          ...gatewayConfig,
          profiles: {
            ...profiles,
            [alias]: profileId,
          },
        },
      },
    };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    receipt = writeBootstrapEnrollmentReceipt('alias', alias, {
      id: alias,
      gateway,
      candidateOrdinal,
      profileIdProvided: true,
      alreadyPresent: Object.hasOwn(profiles, alias),
    });
  }

  return {
    schema: 'webmcp-bootstrap-alias-enrollment/1',
    version: 1,
    applied: apply,
    redacted: true,
    alias: {
      id: alias,
      gateway,
      profileIdProvided: true,
      candidateOrdinal,
      alreadyPresent: Object.hasOwn(profiles, alias),
    },
    receipt,
    next: apply
      ? 'Re-run webmcp bootstrap canary --json, then enroll reviewed binding metadata if needed.'
      : 'Re-run with --yes to write the reviewed logical profile alias.',
  };
}

export function buildProfileCandidates() {
  const { listAllProfiles } = getChromeLauncher();
  const profiles = listAllProfiles();
  const candidates = [];
  let ordinal = 1;
  for (const kind of ['managed', 'existing']) {
    const entries = Array.isArray(profiles[kind]) ? profiles[kind] : [];
    for (const profile of entries) {
      candidates.push({
        ordinal,
        kind,
        displayName: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : `${kind} profile ${ordinal}`,
        hasEmail: typeof profile.email === 'string' && Boolean(profile.email.trim()),
      });
      ordinal += 1;
    }
  }
  return {
    schema: 'webmcp-bootstrap-profile-candidates/1',
    version: 1,
    redacted: true,
    counts: {
      managed: Array.isArray(profiles.managed) ? profiles.managed.length : 0,
      existing: Array.isArray(profiles.existing) ? profiles.existing.length : 0,
      total: candidates.length,
    },
    candidates,
    next: 'Use bootstrap enroll-alias --candidate-ordinal <n> --yes for the reviewed candidate, or webmcp profiles list --json only in an operator-private terminal if an exact physical profile ID is required.',
  };
}

export function buildRoleEnrollment(args) {
  const { flags } = parseFlags(args);
  const role = safeBootstrapId(flags.role, 'role');
  if (!BOOTSTRAP_NODE_ROLES.has(role)) {
    throw new Error('role must be operator, runner-node, or fleet-node');
  }
  const apply = Boolean(flags.yes);
  const serviceIds = expectedServiceIdsForRole(role);
  let receipt = null;
  if (apply) {
    const file = machineRoleConfigPath();
    const config = {
      schema: 'webmcp-machine-role-config/1',
      version: 1,
      role,
      serviceIds,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(file), 0o700); } catch { /* best effort */ }
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    receipt = writeBootstrapEnrollmentReceipt('role', role, {
      role,
      serviceCount: serviceIds.length,
    });
  }
  return {
    schema: 'webmcp-bootstrap-role-enrollment/1',
    version: 1,
    applied: apply,
    redacted: true,
    role: {
      role,
      serviceIds,
    },
    receipt,
    next: apply
      ? 'Re-run webmcp bootstrap plan --json to verify role readiness and review required services.'
      : 'Re-run with --yes to write the reviewed machine role config.',
  };
}
