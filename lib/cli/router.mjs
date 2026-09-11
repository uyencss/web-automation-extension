import { printMcpHelp } from './help.mjs';

const exit = (exitCode) => ({ handled: true, exitCode });
const done = { handled: true };

const COMMANDS = new Map([
  ['mcp', async (args) => {
    if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
      printMcpHelp();
      return done;
    }
    await import('../../server/mcp_server.mjs');
    return done;
  }],
  ['doctor', async (args) => exit(await (await import('./commands/doctor.mjs')).runDoctor(args))],
  ['bootstrap', async (args) => exit(await (await import('./commands/bootstrap/index.mjs')).runBootstrap(args))],
  ['gateway', async (args) => {
    await (await import('./gateway-client.mjs')).runGateway(args);
    return done;
  }],
  ['profiles', async (args) => {
    await (await import('./commands/chrome.mjs')).runProfiles(args);
    return done;
  }],
  ['profile-pool', async (args) => exit(await (await import('../profile-pool/cli.mjs')).runProfilePool(args))],
  ['launch', async (args) => {
    await (await import('./commands/chrome.mjs')).runLaunch(args);
    return done;
  }],
  ['close', async (args) => {
    await (await import('./commands/chrome.mjs')).runClose(args);
    return done;
  }],
  ['quit', async (args) => {
    await (await import('./commands/chrome.mjs')).runQuit(args);
    return done;
  }],
  ['health', async (args) => {
    await (await import('./gateway-client.mjs')).printHealth({ json: args.includes('--json') });
    return done;
  }],
  ['call', async (args) => {
    const [method, rawParams] = args;
    if (!method) {
      console.error('Usage: webmcp-browser call <method> [jsonParams]');
      return exit(1);
    }
    await (await import('./gateway-client.mjs')).callGateway(method, rawParams);
    return done;
  }],
  ['project', async (args) => exit(await (await import('./commands/project/index.mjs')).runProject(args))],
  ['extension-info', async (args) => {
    (await import('./commands/extension.mjs')).runExtensionInfo(args);
    return done;
  }],
  ['extension-path', async () => {
    (await import('./commands/extension.mjs')).runExtensionPath();
    return done;
  }],
]);

export async function routeCommand(command, args) {
  const handler = COMMANDS.get(command);
  if (!handler) return { handled: false };
  return handler(args);
}
