import type { Command } from 'commander';
import { resolve } from 'node:path';
import {
  SCENARIOS,
  CDK_SCENARIOS,
  runNutzapScenario,
  replayNutzapReport,
  type NutzapReport,
} from '@cashu-fault-lab/nutzap-recovery';
import type { CliIo } from '../index.js';
interface Options {
  seed: string;
  mintUrl?: string;
  cdkReceiver?: string;
  output?: string;
}
export function registerNutzapCommands(
  program: Command,
  io: CliIo,
  setExitCode: (code: 0 | 1 | 2) => void,
): void {
  const parent = program
    .command('nutzap')
    .description('NIP-61 redemption and NIP-60 post-spend recovery lab');
  parent
    .command('list')
    .description('List the bounded nutzap fault scenarios')
    .action(() => io.stdout(`${JSON.stringify([...SCENARIOS, ...CDK_SCENARIOS])}\n`));
  const runOptions = (options: Options) => ({
    ...(options.mintUrl ? { mintUrl: options.mintUrl } : {}),
    ...(options.cdkReceiver ? { cdkReceiver: resolve(options.cdkReceiver) } : {}),
  });
  const output = async (reports: NutzapReport[], options: Options, matrix: boolean) => {
    const text = `${JSON.stringify(matrix ? { schemaVersion: 1, suite: 'nip61-recovery-v1', results: reports } : reports[0], null, 2)}\n`;
    if (options.output) await io.writeText(options.output, text);
    io.stdout(text);
    if (reports.some((r) => r.status !== 'passed')) setExitCode(1);
  };
  const configure = (command: Command) =>
    command
      .option('--seed <seed>', 'Scenario seed (only its hash enters reports)', 'nutzap-demo')
      .option('--mint-url <url>', 'Disposable 127.0.0.1 mint; omitted means simulated evidence')
      .option(
        '--cdk-receiver <path>',
        'Native CDK receiver binary; requires --mint-url and adds cross-language matrix scenarios',
      )
      .option('--output <path>', 'Write redacted JSON evidence');
  configure(
    parent.command('run <scenario>').description('Run one NIP-61 recovery scenario'),
  ).action(async (id: string, options: Options) => {
    const report = await runNutzapScenario(id, options.seed, runOptions(options));
    await output([report], options, false);
  });
  configure(
    parent.command('matrix').description('Run all bounded NIP-61 recovery scenarios'),
  ).action(async (options: Options) => {
    const reports: NutzapReport[] = [];
    if (options.cdkReceiver && !options.mintUrl) throw Error('--cdk-receiver requires --mint-url');
    for (const id of options.cdkReceiver ? [...SCENARIOS, ...CDK_SCENARIOS] : SCENARIOS)
      reports.push(await runNutzapScenario(id, options.seed, runOptions(options)));
    await output(reports, options, true);
  });
  configure(
    parent
      .command('replay <artifact>')
      .description('Re-execute a single scenario and compare semantic evidence'),
  ).action(async (path: string, options: Options) => {
    const raw = io.readTextLimited
      ? await io.readTextLimited(path, 65536)
      : await io.readText(path);
    if (Buffer.byteLength(raw) > 65536) throw Error('Nutzap replay exceeds 64 KiB');
    const report = await replayNutzapReport(JSON.parse(raw), options.seed, runOptions(options));
    await output([report], options, false);
  });
}
