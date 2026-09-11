import type { Command } from 'commander';
import {
  SCENARIOS,
  runNutzapScenario,
  replayNutzapReport,
  type NutzapReport,
} from '@cashu-fault-lab/nutzap-recovery';
import type { CliIo } from '../index.js';
interface Options {
  seed: string;
  mintUrl?: string;
  output?: string;
}
export function registerNutzapCommands(
  program: Command,
  io: CliIo,
  setExitCode: (code: 0 | 1 | 2) => void,
): void {
  const parent = program
    .command('nutzap')
    .description('NIP-61 duplicate, concurrent and crash recovery lab');
  parent
    .command('list')
    .description('List the bounded nutzap fault scenarios')
    .action(() => io.stdout(`${JSON.stringify(SCENARIOS)}\n`));
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
      .option('--output <path>', 'Write redacted JSON evidence');
  configure(
    parent.command('run <scenario>').description('Run one NIP-61 recovery scenario'),
  ).action(async (id: string, options: Options) => {
    const report = await runNutzapScenario(
      id,
      options.seed,
      options.mintUrl ? { mintUrl: options.mintUrl } : {},
    );
    await output([report], options, false);
  });
  configure(parent.command('matrix').description('Run all five NIP-61 recovery scenarios')).action(
    async (options: Options) => {
      const reports: NutzapReport[] = [];
      for (const id of SCENARIOS)
        reports.push(
          await runNutzapScenario(
            id,
            options.seed,
            options.mintUrl ? { mintUrl: options.mintUrl } : {},
          ),
        );
      await output(reports, options, true);
    },
  );
  configure(
    parent
      .command('replay <artifact>')
      .description('Re-execute a single scenario and compare semantic evidence'),
  ).action(async (path: string, options: Options) => {
    const raw = io.readTextLimited
      ? await io.readTextLimited(path, 65536)
      : await io.readText(path);
    if (Buffer.byteLength(raw) > 65536) throw Error('Nutzap replay exceeds 64 KiB');
    const report = await replayNutzapReport(
      JSON.parse(raw),
      options.seed,
      options.mintUrl ? { mintUrl: options.mintUrl } : {},
    );
    await output([report], options, false);
  });
}
