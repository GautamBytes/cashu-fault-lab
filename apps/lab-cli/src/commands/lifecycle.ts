import type { Command } from 'commander';
import type { DoctorProbes } from '../doctor.js';
import { defaultDoctorProbes, runDoctor } from '../doctor.js';
import type { CliIo, CliOutcome, LabRuntime } from '../index.js';

export interface LifecycleCommandContext {
  readonly io: CliIo;
  readonly runtime: LabRuntime;
  readonly doctorProbes?: DoctorProbes;
  readonly setExitCode: (exitCode: CliOutcome['exitCode']) => void;
}

export function registerLifecycleCommands(
  program: Command,
  context: LifecycleCommandContext,
): void {
  const { io, runtime, doctorProbes, setExitCode } = context;

  program
    .command('up')
    .description('Start the local lab services')
    .option('--profile <profile>', 'compose profile', 'lab')
    .action(async (options: { profile: string }) => {
      await runtime.up(options.profile);
      io.stdout(`started ${options.profile}\n`);
    });

  program
    .command('down')
    .description('Stop the local lab services')
    .option('--profile <profile>', 'compose profile', 'lab')
    .action(async (options: { profile: string }) => {
      await runtime.down(options.profile);
      io.stdout(`stopped ${options.profile}\n`);
    });

  program
    .command('gen-id')
    .description('Generate a random 128-bit ProtocolId')
    .action(async () => {
      const { generateProtocolId } = await import('@cashu-fault-lab/delivery-core');
      io.stdout(`${generateProtocolId()}\n`);
    });

  program
    .command('doctor')
    .description('Check local prerequisites (env, tools, ports) for funded lab lanes')
    .option('--json', 'emit machine-readable JSON instead of text', false)
    .action(async (options: { json: boolean }) => {
      const report = await runDoctor(doctorProbes ?? defaultDoctorProbes());
      if (options.json) {
        io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        for (const check of report.checks) {
          const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
          io.stdout(`  ${icon} ${check.name}: ${check.detail}\n`);
          if (check.diagnostic !== undefined) {
            io.stdout(`    remediation: ${check.diagnostic.remediation}\n`);
            io.stdout(`    next: ${check.diagnostic.nextCommand}\n`);
          }
        }
        const failedCount = report.checks.filter((c) => c.status === 'fail').length;
        const warnCount = report.checks.filter((c) => c.status === 'warn').length;
        io.stdout(
          `\ndoctor: ${report.checks.length} checks, ${failedCount} failed, ${warnCount} warned\n`,
        );
      }
      if (!report.ok) setExitCode(1);
    });
}
