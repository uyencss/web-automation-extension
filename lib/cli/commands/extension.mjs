import { resolve } from 'node:path';
import { ROOT } from '../context.mjs';
import { getChromeLauncher } from '../component-resolver.mjs';

export function runExtensionInfo(args) {
  const { defaultExtensionPath, WEBMCP_EXTENSION_ID, WEBMCP_EXTENSION_STORE_URL } = getChromeLauncher();
  const payload = {
    id: WEBMCP_EXTENSION_ID,
    name: 'WebMCP Tools Provider',
    chromeWebStoreUrl: WEBMCP_EXTENSION_STORE_URL,
    unpackedExtensionPath: defaultExtensionPath(),
  };
  if (args.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`WebMCP Tools Provider (${payload.id})`);
    console.log(`Chrome Web Store: ${payload.chromeWebStoreUrl}`);
    console.log(`Unpacked extension path: ${payload.unpackedExtensionPath}`);
  }
}

export function runExtensionPath() {
  console.log(resolve(ROOT, 'webmcp-extension', 'dist'));
}
