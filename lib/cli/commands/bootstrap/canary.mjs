import process from 'node:process';
import { existsSync } from 'node:fs';
import { getVaultBin } from '../../component-resolver.mjs';
import { collectDoctorReport } from '../doctor.mjs';
import {
  normalizedReviewDecision,
  readDispatcherConfigForWrite,
} from './config-readiness.mjs';
import { runJsonChild } from './process.mjs';

async function collectVaultDoctorReport() {
  const vaultBin = getVaultBin();
  if (!vaultBin || !existsSync(vaultBin)) {
    return {
      available: false,
      initialized: false,
      unlocked: false,
      error: 'vault CLI not found',
    };
  }
  const result = await runJsonChild(process.execPath, [vaultBin, 'doctor', '--json']);
  const payload = result.payload && typeof result.payload === 'object' ? result.payload : {};
  return {
    available: true,
    initialized: payload.initialized === true,
    unlocked: payload.unlocked === true,
    key: {
      available: payload.key?.available === true,
      source: typeof payload.key?.source === 'string' ? payload.key.source : 'unknown',
      conflict: payload.key?.conflict === true,
      lengthBucket: typeof payload.key?.lengthBucket === 'string' ? payload.key.lengthBucket : 'unknown',
      strengthBucket: typeof payload.key?.strengthBucket === 'string' ? payload.key.strengthBucket : 'unknown',
      keyFileConfigured: payload.key?.keyFile?.configured === true,
    },
    error: result.ok ? null : result.error || null,
  };
}

function declaredProfileAlias(config, alias) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const topProfiles = config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles)
    ? config.profiles
    : {};
  if (Object.hasOwn(topProfiles, alias)) return true;
  const gateways = config.gateways && typeof config.gateways === 'object' && !Array.isArray(config.gateways)
    ? config.gateways
    : {};
  return Object.values(gateways).some((gateway) => Object.hasOwn(
    gateway?.profiles && typeof gateway.profiles === 'object' && !Array.isArray(gateway.profiles)
      ? gateway.profiles
      : {},
    alias,
  ));
}

function readBinding(config, id) {
  const bindings = config?.profileBindings && typeof config.profileBindings === 'object' && !Array.isArray(config.profileBindings)
    ? config.profileBindings
    : {};
  const binding = bindings[id];
  return binding && typeof binding === 'object' && !Array.isArray(binding) ? binding : null;
}

function redactedBindingStatus(binding) {
  const decision = normalizedReviewDecision(binding);
  const reauthPolicy = typeof binding?.reauthPolicy === 'string' ? binding.reauthPolicy : null;
  const hasCredentialRef = Boolean(binding?.credentialRefs && typeof binding.credentialRefs === 'object' && !Array.isArray(binding.credentialRefs));
  const hasSiteAccountRef = typeof binding?.siteAccountRef === 'string' && Boolean(binding.siteAccountRef.trim());
  const hasProfileIdentityRef = typeof binding?.profileIdentityRef === 'string' && Boolean(binding.profileIdentityRef.trim());
  const downloadPolicy = typeof binding?.downloadPolicy === 'string' ? binding.downloadPolicy : null;
  return {
    declared: Boolean(binding),
    gateway: typeof binding?.gateway === 'string' && binding.gateway.trim() ? binding.gateway : null,
    profileAlias: typeof binding?.profileAlias === 'string' && binding.profileAlias.trim() ? binding.profileAlias : null,
    decision,
    reauthPolicy,
    reauthReady: reauthPolicy === 'bounded-one-attempt' && hasCredentialRef,
    hasCredentialRef,
    hasSiteAccountRef,
    hasProfileIdentityRef,
    downloadPolicy,
  };
}

function bindingPlanNextAction(action) {
  if (action.code === 'ENROLL_CANARY_PROFILE_ALIAS') {
    return { code: action.code, command: 'webmcp bootstrap profile-candidates --json && webmcp bootstrap enroll-alias --gateway local --alias local-auth-fixture --candidate-ordinal <n> --yes --json', note: 'Pick the operator-reviewed redacted candidate ordinal for the local auth fixture profile.' };
  }
  if (action.code === 'ENROLL_PROFILE_BINDING' || action.code === 'APPROVE_PROFILE_BINDING' || action.code === 'ENROLL_BOUNDED_REAUTH_BINDING') {
    return { code: action.code, command: 'webmcp bootstrap enroll-binding --id local-auth-fixture --gateway local --profile-alias local-auth-fixture --decision approved --reauth-policy bounded-one-attempt --credential-purpose-ref <purpose-ref> --site-account-ref <site-account-ref> --download-policy run-staging --yes --json', note: 'Write only reviewed opaque refs; command output and receipt remain redacted.' };
  }
  if (action.code === 'ADD_SITE_ACCOUNT_REF') {
    return { code: action.code, command: 'webmcp bootstrap enroll-binding --id local-auth-fixture --gateway local --profile-alias local-auth-fixture --decision approved --reauth-policy bounded-one-attempt --credential-purpose-ref <purpose-ref> --site-account-ref <site-account-ref> --yes --json', note: 'Add the reviewed site account opaque ref before live account verification.' };
  }
  return { code: action.code, command: 'webmcp bootstrap binding-plan --json', note: 'Review binding readiness.' };
}

export function buildBindingPlan() {
  const { config } = readDispatcherConfigForWrite();
  const aliasId = 'local-auth-fixture';
  const bindingId = 'local-auth-fixture';
  const aliasDeclared = declaredProfileAlias(config, aliasId);
  const binding = readBinding(config, bindingId);
  const bindingStatus = redactedBindingStatus(binding);
  const actions = [];
  if (!aliasDeclared) actions.push({ code: 'ENROLL_CANARY_PROFILE_ALIAS', status: 'required' });
  if (!bindingStatus.declared) actions.push({ code: 'ENROLL_PROFILE_BINDING', status: 'required' });
  else {
    if (bindingStatus.decision !== 'approved') actions.push({ code: 'APPROVE_PROFILE_BINDING', status: 'required' });
    if (!bindingStatus.reauthReady) actions.push({ code: 'ENROLL_BOUNDED_REAUTH_BINDING', status: 'required' });
    if (!bindingStatus.hasSiteAccountRef) actions.push({ code: 'ADD_SITE_ACCOUNT_REF', status: 'required' });
  }
  return {
    schema: 'webmcp-bootstrap-binding-plan/1',
    version: 1,
    ok: actions.length === 0,
    redacted: true,
    alias: {
      id: aliasId,
      declared: aliasDeclared,
    },
    binding: {
      id: bindingId,
      ...bindingStatus,
    },
    actions,
    nextActions: actions.map(bindingPlanNextAction),
    next: actions.length
      ? 'Resolve binding actions, then re-run webmcp bootstrap binding-plan --json.'
      : 'Re-run webmcp bootstrap canary --json; canary alias and binding readiness are satisfied.',
  };
}

export async function buildBootstrapCanaryReadiness() {
  const doctor = await collectDoctorReport();
  const vault = await collectVaultDoctorReport();
  const bindingSummary = doctor.dispatcher?.profileBindings ?? {};
  const { config: dispatcherConfig } = doctor.dispatcher?.readable ? readDispatcherConfigForWrite() : { config: null };
  const declaredCanaryProfileAlias = Boolean(dispatcherConfig && (
    Object.hasOwn(dispatcherConfig.profiles && typeof dispatcherConfig.profiles === 'object' && !Array.isArray(dispatcherConfig.profiles)
      ? dispatcherConfig.profiles
      : {}, 'local-auth-fixture')
    || Object.values(dispatcherConfig.gateways && typeof dispatcherConfig.gateways === 'object' && !Array.isArray(dispatcherConfig.gateways)
      ? dispatcherConfig.gateways
      : {}).some((gateway) => Object.hasOwn(gateway?.profiles && typeof gateway.profiles === 'object' && !Array.isArray(gateway.profiles)
        ? gateway.profiles
        : {}, 'local-auth-fixture'))
  ));
  const blockers = [];
  if (!doctor.bootstrap.mcpRegistered) blockers.push({ code: 'REGISTER_MCP', status: 'required' });
  if (!doctor.bootstrap.dispatcherConfigured) blockers.push({ code: 'WRITE_DISPATCHER_CONFIG', status: 'required' });
  if (!doctor.bootstrap.skillsReady || !doctor.skills.receiptPresent) blockers.push({ code: 'INSTALL_SKILLS', status: 'required' });
  if (!doctor.bootstrap.gatewayReady) blockers.push({ code: 'START_GATEWAY', status: 'required' });
  if (!doctor.bootstrap.downloadPolicyReady) blockers.push({ code: 'INSTALL_CHROME_POLICY', status: 'required' });
  if (!doctor.bootstrap.roleConfigured) blockers.push({ code: 'SET_NODE_ROLE', status: 'required' });
  if (!doctor.bootstrap.serviceReady) blockers.push({ code: 'INSTALL_ROLE_SERVICES', status: 'required' });
  if (!doctor.bootstrap.tailnetReady) blockers.push({ code: 'CONNECT_TAILNET', status: 'required' });
  if (!vault.available) blockers.push({ code: 'INSTALL_VAULT_CLI', status: 'required' });
  else if (!vault.initialized) blockers.push({ code: 'INITIALIZE_VAULT', status: 'required' });
  else if (!vault.unlocked) blockers.push({ code: 'UNLOCK_VAULT', status: 'required' });
  if (!declaredCanaryProfileAlias) blockers.push({ code: 'ENROLL_CANARY_PROFILE_ALIAS', status: 'required' });
  if ((bindingSummary.count ?? 0) < 1) blockers.push({ code: 'ENROLL_PROFILE_BINDING', status: 'required' });
  if ((bindingSummary.boundedReauth ?? 0) < 1) blockers.push({ code: 'ENROLL_BOUNDED_REAUTH_BINDING', status: 'required' });

  const ok = blockers.length === 0;
  const nextActions = blockers.map((blocker) => {
    if (blocker.code === 'REGISTER_MCP') {
      return { code: blocker.code, command: 'webmcp bootstrap apply --json', note: 'Apply local bootstrap state, then restart Codex so MCP registrations are loaded by the new task.' };
    }
    if (blocker.code === 'WRITE_DISPATCHER_CONFIG') {
      return { code: blocker.code, command: 'webmcp bootstrap apply --json', note: 'Create the local dispatcher/bootstrap roots before enrollment.' };
    }
    if (blocker.code === 'INSTALL_SKILLS') {
      return { code: blocker.code, command: 'webmcp skills adopt --all --yes && webmcp bootstrap apply --json', note: 'Adopt reviewed WebMCP skills, then refresh bootstrap receipt.' };
    }
    if (blocker.code === 'START_GATEWAY') {
      return { code: blocker.code, command: 'webmcp gateway start', note: 'Start the local Gateway before re-running canary readiness.' };
    }
    if (blocker.code === 'INSTALL_CHROME_POLICY') {
      return { code: blocker.code, command: 'webmcp bootstrap plan --json', note: 'Review the OS-specific installer action for managed downloads; policy install may require operator/admin action.' };
    }
    if (blocker.code === 'SET_NODE_ROLE') {
      return { code: blocker.code, command: 'webmcp bootstrap enroll-role --role <operator|runner-node|fleet-node> --yes --json', note: 'Select and persist a reviewed node role before role-specific service install.' };
    }
    if (blocker.code === 'INSTALL_ROLE_SERVICES') {
      return { code: blocker.code, command: 'webmcp bootstrap service-plan --json && webmcp bootstrap service-apply --json', note: 'Render reviewed local service templates before any OS-level service installation.' };
    }
    if (blocker.code === 'CONNECT_TAILNET') {
      return { code: blocker.code, command: 'tailscale status --json && webmcp doctor --json', note: 'Connect the node to the reviewed Tailnet; doctor output remains redacted.' };
    }
    if (blocker.code === 'INSTALL_VAULT_CLI') {
      return { code: blocker.code, command: 'webmcp vault doctor --json', note: 'Confirm Vault Kit availability before credential-bound canaries.' };
    }
    if (blocker.code === 'INITIALIZE_VAULT') {
      return { code: blocker.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp vault init --json', note: 'Initialize the encrypted local Vault with an operator-private key file.' };
    }
    if (blocker.code === 'UNLOCK_VAULT') {
      return { code: blocker.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp bootstrap canary --json', note: 'Re-run readiness with the key available; do not paste the key into shared logs.' };
    }
    if (blocker.code === 'ENROLL_CANARY_PROFILE_ALIAS') {
      return { code: blocker.code, command: 'webmcp bootstrap profile-candidates --json && webmcp bootstrap enroll-alias --gateway local --alias local-auth-fixture --candidate-ordinal <n> --yes --json', note: 'Pick the operator-reviewed redacted candidate ordinal for the local auth fixture profile.' };
    }
    if (blocker.code === 'ENROLL_PROFILE_BINDING' || blocker.code === 'ENROLL_BOUNDED_REAUTH_BINDING') {
      return { code: blocker.code, command: 'webmcp bootstrap enroll-binding --id local-auth-fixture --gateway local --profile-alias local-auth-fixture --decision approved --reauth-policy bounded-one-attempt --credential-purpose-ref <purpose-ref> --site-account-ref <site-account-ref> --download-policy run-staging --yes --json', note: 'Write only reviewed opaque refs; command output and receipt remain redacted.' };
    }
    return { code: blocker.code, command: 'webmcp bootstrap plan --json', note: 'Review this blocker before applying changes.' };
  });
  return {
    schema: 'webmcp-bootstrap-canary-readiness/1',
    version: 1,
    ok,
    redacted: true,
    canary: 'local-auth-fixture-reauth-canary',
    readiness: {
      mcpRegistered: doctor.bootstrap.mcpRegistered,
      dispatcherConfigured: doctor.bootstrap.dispatcherConfigured,
      downloadPolicyReady: doctor.bootstrap.downloadPolicyReady,
      skillsReady: doctor.bootstrap.skillsReady,
      gatewayReady: doctor.bootstrap.gatewayReady,
      roleConfigured: doctor.bootstrap.roleConfigured,
      serviceReady: doctor.bootstrap.serviceReady,
      tailnetReady: doctor.bootstrap.tailnetReady,
      vaultInitialized: vault.initialized,
      vaultUnlocked: vault.unlocked,
      canaryProfileAliasDeclared: declaredCanaryProfileAlias,
      profileBindings: bindingSummary.count ?? 0,
      boundedReauthBindings: bindingSummary.boundedReauth ?? 0,
    },
    vault: {
      available: vault.available,
      initialized: vault.initialized,
      unlocked: vault.unlocked,
      key: vault.key ?? null,
    },
    blockers,
    nextActions,
    next: ok
      ? 'Run the Store-owned canary through Fleet/Controller from a task with WebMCP MCP tools attached.'
      : 'Resolve blockers, then re-run webmcp bootstrap canary --json before a live browser canary.',
  };
}

export async function buildVaultKeyPlan() {
  const vault = await collectVaultDoctorReport();
  const actions = [];
  if (!vault.available) actions.push({ code: 'INSTALL_VAULT_CLI', status: 'required' });
  else if (!vault.initialized) actions.push({ code: 'INITIALIZE_VAULT', status: 'required' });
  if (vault.available && !vault.key?.available) actions.push({ code: 'CONFIGURE_VAULT_KEY_FILE', status: 'required' });
  if (vault.available && vault.key?.available && !vault.unlocked) actions.push({ code: 'FIX_VAULT_KEY', status: 'required' });
  if (vault.key?.conflict) actions.push({ code: 'REMOVE_VAULT_KEY_CONFLICT', status: 'required' });
  const nextActions = actions.map((action) => {
    if (action.code === 'INSTALL_VAULT_CLI') {
      return { code: action.code, command: 'webmcp vault doctor --json', note: 'Install or expose the WebMCP Vault CLI before credential-bound canaries.' };
    }
    if (action.code === 'INITIALIZE_VAULT') {
      return { code: action.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp vault init --json', note: 'Initialize the local encrypted Vault with an operator-private key file.' };
    }
    if (action.code === 'CONFIGURE_VAULT_KEY_FILE') {
      return { code: action.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp bootstrap vault-key-plan --json', note: 'Use a private key file; do not paste the key into shared command logs.' };
    }
    if (action.code === 'FIX_VAULT_KEY') {
      return { code: action.code, command: 'WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp vault doctor --json', note: 'The configured key is present but did not unlock the initialized Vault.' };
    }
    if (action.code === 'REMOVE_VAULT_KEY_CONFLICT') {
      return { code: action.code, command: 'unset WEBMCP_VAULT_KEY; WEBMCP_VAULT_KEY_FILE=<private-key-file> webmcp bootstrap vault-key-plan --json', note: 'Use exactly one Vault key source for deterministic unattended runs.' };
    }
    return { code: action.code, command: 'webmcp bootstrap vault-key-plan --json', note: 'Review Vault key-provider readiness.' };
  });
  return {
    schema: 'webmcp-bootstrap-vault-key-plan/1',
    version: 1,
    ok: vault.available === true && vault.initialized === true && vault.unlocked === true && vault.key?.conflict !== true,
    redacted: true,
    vault: {
      available: vault.available,
      initialized: vault.initialized,
      unlocked: vault.unlocked,
      key: vault.key ?? null,
    },
    actions,
    nextActions,
    next: actions.length
      ? 'Resolve Vault key-provider actions, then re-run webmcp bootstrap vault-key-plan --json.'
      : 'Re-run webmcp bootstrap canary --json; Vault key-provider readiness is satisfied.',
  };
}
