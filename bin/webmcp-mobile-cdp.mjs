#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createMobileSession } from '../webmcp-mobile-cdp/session.mjs';
import { dispatchCommand, connectGateway } from '../webmcp-mobile-cdp/dispatch.mjs';

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function printHelp() {
  console.log(`WebMCP Zero-Extension Android Chrome CDP Automation

Usage:
  webmcp mobile-cdp status [--serial <serial>] [--json]
  webmcp mobile-cdp connect [--serial <serial>] [--gateway-url <url>] [--profile-id <id>] [--profile-name <name>]
  webmcp mobile-cdp call <method> [json_params] [--serial <serial>]
  webmcp mobile-cdp help|--help|-h

Options:
  --serial <serial>         ADB device serial or endpoint (e.g. 100.118.203.105:5555)
  --gateway-url <url>       WebMCP Gateway WS URL (default: ws://127.0.0.1:7865)
  --profile-id <id>         Profile ID to register with gateway (default: mobile-xm13)
  --profile-name <name>     Profile display name (default: Android Chrome CDP)
  --json                    Output status as JSON

Examples:
  webmcp mobile-cdp status
  webmcp mobile-cdp connect --profile-id mobile-xm13
  webmcp mobile-cdp call listTabs
  webmcp mobile-cdp call newTab '{"url":"https://example.com"}'
  webmcp mobile-cdp call getAriaSnapshot '{"tabId":"..."}'
  webmcp mobile-cdp call clickByRef '{"ref":"R1"}'
  webmcp mobile-cdp call typeByRef '{"ref":"R2","text":"Xin chào 🇻🇳","submit":true}'
`);
}

async function handleStatus(flags) {
  const serial = flags.serial || process.env.ANDROID_SERIAL || null;
  const result = {
    ok: true,
    serial: serial || 'default',
    adbAvailable: false,
    devices: [],
    forwardPort: null,
    chromeRunning: false,
  };

  try {
    const adbOutput = execFileSync('adb', ['devices'], { encoding: 'utf8' });
    result.adbAvailable = true;
    const lines = adbOutput.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    result.devices = lines.map(line => {
      const [id, state] = line.split(/\s+/);
      return { id, state };
    });
  } catch (err) {
    result.ok = false;
    result.error = `ADB not available or failed: ${err.message}`;
  }

  if (result.adbAvailable) {
    try {
      const adbArgs = [...(serial ? ['-s', serial] : []), 'forward', '--list'];
      const forwards = execFileSync('adb', adbArgs, { encoding: 'utf8' });
      for (const f of forwards.split('\n')) {
        if (f.includes('chrome_devtools_remote')) {
          const match = f.match(/tcp:(\d+)/);
          if (match) {
            result.forwardPort = parseInt(match[1], 10);
            result.chromeRunning = true;
            break;
          }
        }
      }
    } catch {}
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Android Chrome CDP Status:`);
    console.log(`  ADB:            ${result.adbAvailable ? 'OK' : 'Not found'}`);
    console.log(`  Serial:         ${result.serial}`);
    console.log(`  Devices:        ${result.devices.map(d => `${d.id} (${d.state})`).join(', ') || 'None'}`);
    console.log(`  Chrome CDP:     ${result.chromeRunning ? `Active on port ${result.forwardPort}` : 'Not forwarded yet'}`);
  }
  return result.ok ? 0 : 1;
}

async function handleConnect(flags) {
  const serial = flags.serial || process.env.ANDROID_SERIAL || null;
  const gatewayUrl = flags['gateway-url'] || process.env.WEBMCP_GATEWAY_URL || 'ws://127.0.0.1:7865';
  const profileId = flags['profile-id'] || 'mobile-xm13';
  const profileName = flags['profile-name'] || 'Android Chrome CDP';

  console.log(`[mobile-cdp] Initializing mobile session (serial: ${serial || 'default'})...`);
  const session = createMobileSession({ serial });
  await session.init();
  console.log(`[mobile-cdp] Attached to Chrome Android CDP on port ${session.port}`);

  console.log(`[mobile-cdp] Connecting to WebMCP Gateway at ${gatewayUrl} as "${profileId}"...`);
  const ws = connectGateway(session, { gatewayUrl, profileId, profileName });

  const cleanup = async () => {
    console.log('\n[mobile-cdp] Disconnecting from gateway and closing session...');
    try { ws.close(); } catch {}
    try { await session.close(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise(() => {});
}

async function handleCall(positional, flags) {
  const method = positional[1];
  if (!method) {
    console.error('Error: method is required. Example: webmcp mobile-cdp call listTabs');
    return 1;
  }

  let params = {};
  if (positional[2]) {
    try {
      params = JSON.parse(positional[2]);
    } catch (e) {
      console.error(`Error parsing JSON params: ${e.message}`);
      return 1;
    }
  }

  const serial = flags.serial || process.env.ANDROID_SERIAL || null;
  const session = createMobileSession({ serial });
  try {
    await session.init();
    const result = await dispatchCommand(session, method, params);
    console.log(JSON.stringify(result, null, 2));
    await session.close();
    return 0;
  } catch (err) {
    console.error(`Command execution failed: ${err.message || err}`);
    try { await session.close(); } catch {}
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0] || 'help';

  if (command === 'help' || command === '--help' || command === '-h' || flags.help) {
    printHelp();
    return 0;
  }

  if (command === 'status') {
    return await handleStatus(flags);
  }

  if (command === 'connect') {
    return await handleConnect(flags);
  }

  if (command === 'call') {
    return await handleCall(positional, flags);
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('webmcp-mobile-cdp.mjs')) {
  main().then(code => { process.exitCode = code; });
}
