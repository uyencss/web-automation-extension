import process from 'node:process';
import { PACKAGE_VERSION } from './context.mjs';
import { printHelp } from './help.mjs';
import { printUnhandledError } from './output.mjs';
import { routeCommand } from './router.mjs';

export async function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...args] = argv;
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      printHelp();
      process.exit(command ? 0 : 1);
    }
    if (command === '--version' || command === '-v') {
      console.log(PACKAGE_VERSION);
      return;
    }

    const outcome = await routeCommand(command, args);
    if (outcome.handled) {
      if (outcome.exitCode !== undefined) process.exit(outcome.exitCode);
      return;
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  } catch (error) {
    printUnhandledError(error);
    process.exit(1);
  }
}
