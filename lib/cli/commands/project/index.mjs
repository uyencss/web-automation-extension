import { printProjectHelp } from '../../help.mjs';
import { runProjectCharter, runProjectGuide } from './charter-guide.mjs';
import { runProjectNew } from './create.mjs';
import {
  runProjectAttach,
  runProjectDoctor,
  runProjectWhere,
  runRunner,
} from './registry.mjs';
import { runProjectSchedule } from './schedule.mjs';

export async function runProject(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printProjectHelp();
    return 0;
  }
  if (subcommand === 'attach') return runProjectAttach(rest);
  if (subcommand === 'list') return runRunner(['workspace', 'list', ...rest]);
  if (subcommand === 'where') return runProjectWhere(rest);
  if (subcommand === 'doctor') return runProjectDoctor(rest);
  if (subcommand === 'new') return runProjectNew(rest);
  if (subcommand === 'charter') return runProjectCharter(rest);
  if (subcommand === 'guide') return runProjectGuide(rest);
  if (subcommand === 'schedule') return runProjectSchedule(rest);
  // Project Store commands — thin bridge onto Runner's project.* surface (R6.1)
  if (subcommand === 'init' || subcommand === 'init-store') return runRunner(['project', 'init-store', ...rest]);
  if (subcommand === 'build-index') return runRunner(['project', 'build-index', ...rest]);
  if (subcommand === 'export-pack') return runRunner(['project', 'export-pack', ...rest]);
  console.error(`Unknown project command: ${subcommand}`);
  printProjectHelp();
  return 2;
}
