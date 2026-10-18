import { resolveTabId } from '../utils.js';
import { evaluateInTab, sendCDPCommand } from '../cdp-bridge.js';

function base64UrlToStandardBase64(input) {
  const str = String(input || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!str) return '';
  const pad = str.length % 4;
  return pad ? str + '='.repeat(4 - pad) : str;
}

export const passkeyActionHandlers = {
  /**
   * Agent Passkey Provider (`passkey.authenticateWithVirtualAuthenticator`):
   * Attaches a temporary CTAP2 Internal Virtual Authenticator to the target tab,
   * injects the leased PKCS#8 Passkey credential, optionally clicks the page's
   * passkey sign-in trigger, waits briefly for WebAuthn completion, and removes
   * the Virtual Authenticator in a `finally` block so hardware keys are unaffected.
   */
  async 'passkey.authenticateWithVirtualAuthenticator'(params = {}) {
    const tabId = await resolveTabId(params);
    const cred = params.credential || {};
    if (!cred.credentialId || !cred.rpId || !cred.privateKey) {
      throw new Error('passkey.authenticateWithVirtualAuthenticator requires credential.{credentialId, rpId, privateKey}.');
    }

    let authenticatorId = null;
    try {
      await sendCDPCommand(tabId, 'WebAuthn.enable', { enableUI: false });
      const added = await sendCDPCommand(tabId, 'WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
          defaultBackupEligibility: cred.backupEligibility !== false,
          defaultBackupState: cred.backupState !== false,
        },
      });
      authenticatorId = added.authenticatorId;

      await sendCDPCommand(tabId, 'WebAuthn.addCredential', {
        authenticatorId,
        credential: {
          credentialId: base64UrlToStandardBase64(cred.credentialId),
          isResidentCredential: cred.isResidentCredential !== false,
          rpId: cred.rpId,
          privateKey: String(cred.privateKey).trim(),
          userHandle: base64UrlToStandardBase64(cred.userHandle || ''),
          signCount: Number(cred.signCount || 0) >>> 0,
          backupEligibility: cred.backupEligibility !== false,
          backupState: cred.backupState !== false,
        },
      });

      if (params.triggerSelector) {
        const selectorJson = JSON.stringify(String(params.triggerSelector));
        await evaluateInTab(
          tabId,
          `(() => {
            const el = document.querySelector(${selectorJson});
            if (!el) throw new Error('Passkey trigger selector not found: ' + ${selectorJson});
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            el.click();
            return { clicked: true };
          })()`
        );
      }

      // Allow in-flight navigator.credentials.get() to resolve against the virtual authenticator
      const settleMs = Math.min(Math.max(Number(params.settleMs ?? 1500), 200), 10000);
      await new Promise((r) => setTimeout(r, settleMs));

      return {
        tabId,
        ok: true,
        rpId: cred.rpId,
        triggered: Boolean(params.triggerSelector),
      };
    } finally {
      if (authenticatorId) {
        try {
          await sendCDPCommand(tabId, 'WebAuthn.removeVirtualAuthenticator', { authenticatorId });
        } catch {}
      }
      try {
        await sendCDPCommand(tabId, 'WebAuthn.disable', {});
      } catch {}
    }
  },

  /**
   * Agent Vault Autofill (`vault.autofill`):
   * Signals the isolated `WebMCP Vault Companion` extension on the target tab to
   * auto-fill matching credentials (username, password, 2FA TOTP) directly from
   * the local Vault Kit without ever exposing plaintext secrets to the AI model
   * or MAIN world.
   */
  async 'vault.autofill'(params = {}) {
    const tabId = await resolveTabId(params);
    const payloadJson = JSON.stringify({
      id: 'agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      action: params.action === 'openSelector' ? 'openSelector' : 'autofill',
      params: {
        usernameHint: typeof params.usernameHint === 'string' ? params.usernameHint : '',
        itemId: typeof params.itemId === 'string' ? params.itemId : '',
        submit: Boolean(params.submit),
      },
    });

    const result = await evaluateInTab(
      tabId,
      `new Promise((resolve) => {
        const req = ${payloadJson};
        const timer = setTimeout(() => {
          window.removeEventListener('__webmcp_vault_agent_res__', onRes);
          resolve({
            ok: false,
            filled: false,
            error: 'Timed out waiting for WebMCP Vault Companion extension on this tab.',
          });
        }, 4000);
        function onRes(event) {
          try {
            const detail = typeof event?.detail === 'string' ? JSON.parse(event.detail) : event?.detail;
            if (!detail || detail.id !== req.id) return;
            clearTimeout(timer);
            window.removeEventListener('__webmcp_vault_agent_res__', onRes);
            resolve(detail.payload || { ok: false, error: 'Empty response from Vault Companion' });
          } catch {}
        }
        window.addEventListener('__webmcp_vault_agent_res__', onRes);
        window.dispatchEvent(
          new CustomEvent('__webmcp_vault_agent_cmd__', {
            detail: JSON.stringify(req),
          })
        );
      })`
    );

    return {
      tabId,
      ...(result || { ok: false, error: 'No response from tab' }),
    };
  },
};

