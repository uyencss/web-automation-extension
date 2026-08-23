import { printBootstrapHelp } from '../../help.mjs';
import {
  buildBindingPlan,
  buildBootstrapCanaryReadiness,
  buildVaultKeyPlan,
} from './canary.mjs';
import {
  buildAliasEnrollment,
  buildBindingEnrollment,
  buildProfileCandidates,
  buildRoleEnrollment,
} from './enrollment.mjs';
import { buildBootstrapPlan } from './receipts.mjs';
import {
  buildServiceInstallPlan,
  buildServiceLoadPlan,
  buildServicePlan,
  buildTailnetPlan,
} from './service-plans.mjs';

export async function runBootstrap(args) {
  const [subcommand = 'plan'] = args.filter((arg) => !arg.startsWith('--'));
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h') || subcommand === 'help') {
    printBootstrapHelp();
    return 0;
  }
  if (!['plan', 'apply', 'canary', 'vault-key-plan', 'binding-plan', 'tailnet-plan', 'tailnet-apply', 'profile-candidates', 'enroll-role', 'service-plan', 'service-apply', 'service-install-plan', 'service-install', 'service-load-plan', 'service-load', 'enroll-alias', 'enroll-binding'].includes(subcommand)) {
    console.error('Usage: webmcp bootstrap plan|apply|canary|vault-key-plan|binding-plan|tailnet-plan|tailnet-apply|profile-candidates|enroll-role|service-plan|service-apply|service-install-plan|service-install|service-load-plan|service-load|enroll-alias|enroll-binding [--json]');
    return 2;
  }
  if (subcommand === 'canary') {
    const readiness = await buildBootstrapCanaryReadiness();
    if (json) console.log(JSON.stringify(readiness, null, 2));
    else {
      console.log(`WebMCP bootstrap canary: ${readiness.ok ? 'ready' : 'blocked'}`);
      console.log(`  Readiness: gateway=${readiness.readiness.gatewayReady ? 'ready' : 'missing'}, vault=${readiness.readiness.vaultUnlocked ? 'unlocked' : 'locked'}`);
      if (readiness.blockers.length) {
        console.log(`  Blockers: ${readiness.blockers.map((item) => item.code).join(', ')}`);
      }
    }
    return readiness.ok ? 0 : 1;
  }
  if (subcommand === 'vault-key-plan') {
    const plan = await buildVaultKeyPlan();
    if (json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`WebMCP bootstrap vault-key-plan: ${plan.ok ? 'ready' : 'blocked'}`);
      if (plan.actions.length) console.log(`  Actions: ${plan.actions.map((item) => item.code).join(', ')}`);
      console.log(`  Next: ${plan.next}`);
    }
    return plan.ok ? 0 : 1;
  }
  if (subcommand === 'binding-plan') {
    try {
      const plan = buildBindingPlan();
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap binding-plan: ${plan.ok ? 'ready' : 'blocked'}`);
        if (plan.actions.length) console.log(`  Actions: ${plan.actions.map((item) => item.code).join(', ')}`);
        console.log(`  Next: ${plan.next}`);
      }
      return plan.ok ? 0 : 1;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-binding-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'tailnet-plan' || subcommand === 'tailnet-apply') {
    try {
      const plan = await buildTailnetPlan({ apply: subcommand === 'tailnet-apply' && args.includes('--yes') });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.ok ? 'ready' : 'blocked'}`);
        if (plan.actions.length) console.log(`  Actions: ${plan.actions.map((item) => item.code).join(', ')}`);
        console.log(`  Next: ${plan.next}`);
      }
      return plan.ok ? 0 : 1;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-tailnet-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'profile-candidates') {
    const candidates = buildProfileCandidates();
    if (json) console.log(JSON.stringify(candidates, null, 2));
    else {
      console.log(`WebMCP bootstrap profile candidates: ${candidates.counts.total}`);
      for (const candidate of candidates.candidates) {
        console.log(`  ${candidate.ordinal}. ${candidate.kind}: ${candidate.displayName}${candidate.hasEmail ? ' (email present)' : ''}`);
      }
    }
    return 0;
  }
  if (subcommand === 'enroll-role') {
    try {
      const enrollment = buildRoleEnrollment(args);
      if (json) console.log(JSON.stringify(enrollment, null, 2));
      else {
        console.log(`WebMCP bootstrap enroll-role: ${enrollment.applied ? 'applied' : 'dry-run'}`);
        console.log(`  Role: ${enrollment.role.role}`);
        console.log(`  Next: ${enrollment.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-role-enrollment/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'service-plan' || subcommand === 'service-apply') {
    try {
      const plan = buildServicePlan({ apply: subcommand === 'service-apply' });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.applied ? 'rendered' : 'planned'} ${plan.services.length} service template(s)`);
        console.log(`  Role: ${plan.role}`);
        console.log(`  Next: ${plan.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-service-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'service-install-plan' || subcommand === 'service-install') {
    try {
      const plan = buildServiceInstallPlan({ apply: subcommand === 'service-install' && args.includes('--yes') });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.applied ? 'installed' : 'planned'} ${plan.services.length} user service file(s)`);
        console.log(`  Role: ${plan.role}`);
        console.log(`  Next: ${plan.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-service-install-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'service-load-plan' || subcommand === 'service-load') {
    try {
      const plan = buildServiceLoadPlan({ apply: subcommand === 'service-load' && args.includes('--yes') });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else {
        console.log(`WebMCP bootstrap ${subcommand}: ${plan.applied ? 'loaded' : 'planned'} ${plan.services.length} user service(s)`);
        console.log(`  Role: ${plan.role}`);
        console.log(`  Next: ${plan.next}`);
      }
      return 0;
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-service-load-plan/1',
          ok: false,
          error: error.message,
        }, null, 2));
      } else console.error(error.message);
      return 2;
    }
  }
  if (subcommand === 'enroll-alias') {
    try {
      const enrollment = buildAliasEnrollment(args.slice(1));
      if (json) console.log(JSON.stringify(enrollment, null, 2));
      else {
        console.log(`WebMCP bootstrap enroll-alias: ${enrollment.applied ? 'applied' : 'dry-run'}`);
        console.log(`  Alias: ${enrollment.alias.id} on ${enrollment.alias.gateway}`);
      }
      return 0;
    } catch (error) {
      const message = error?.message || String(error);
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-alias-enrollment/1',
          version: 1,
          applied: false,
          redacted: true,
          ok: false,
          error: message,
        }, null, 2));
      } else {
        console.error(message);
      }
      return 1;
    }
  }
  if (subcommand === 'enroll-binding') {
    try {
      const enrollment = buildBindingEnrollment(args.slice(1));
      if (json) console.log(JSON.stringify(enrollment, null, 2));
      else {
        console.log(`WebMCP bootstrap enroll-binding: ${enrollment.applied ? 'applied' : 'dry-run'}`);
        console.log(`  Binding: ${enrollment.binding.id} -> ${enrollment.binding.gateway}/${enrollment.binding.profileAlias}`);
        console.log(`  Reauth: ${enrollment.binding.reauthReady ? 'bounded' : 'not ready'}`);
      }
      return 0;
    } catch (error) {
      const message = error?.message || String(error);
      if (json) {
        console.log(JSON.stringify({
          schema: 'webmcp-bootstrap-binding-enrollment/1',
          version: 1,
          applied: false,
          redacted: true,
          ok: false,
          error: message,
        }, null, 2));
      } else {
        console.error(message);
      }
      return 1;
    }
  }
  const plan = await buildBootstrapPlan({ apply: subcommand === 'apply' });
  if (json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`WebMCP bootstrap ${plan.mode}: ${plan.applied ? 'applied safe local state' : 'planned safe local state'}`);
    console.log(`  Readiness: ${plan.readiness.ok ? 'ready' : 'needs operator action'}`);
    console.log(`  Mutations: ${plan.mutations.map((item) => `${item.target}:${item.status}`).join(', ')}`);
    if (plan.operatorActions.length) {
      console.log(`  Operator actions: ${plan.operatorActions.map((item) => item.code).join(', ')}`);
    }
  }
  return 0;
}
