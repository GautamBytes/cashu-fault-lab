import type { Command } from 'commander';
import type { DoctorProbes } from '../doctor.js';
import { defaultDoctorProbes, runDoctor } from '../doctor.js';
import { LabDiagnosticError } from '../diagnostics.js';
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
      const startup = await runDoctor(doctorProbes ?? defaultDoctorProbes(), {
        environment: false,
        senderDurability: false,
        cargo: false,
        testTiers: false,
        portConflict: 'warn',
      });
      const blocker = startup.checks.find((check) => check.status === 'fail');
      if (blocker !== undefined) {
        if (blocker.diagnostic !== undefined) throw new LabDiagnosticError(blocker.diagnostic);
        throw new Error(`${blocker.name} is not ready: ${blocker.detail}`);
      }
      const portConflict = startup.checks.find(
        (check) => check.status === 'warn' && check.diagnostic?.code === 'PORT_IN_USE',
      );
      let result: Awaited<ReturnType<LabRuntime['up']>>;
      try {
        result = await runtime.up(options.profile);
      } catch (error) {
        if (portConflict?.diagnostic !== undefined) {
          throw new LabDiagnosticError(portConflict.diagnostic);
        }
        throw error;
      }
      io.stdout(`started ${options.profile}\n`);
      if (result !== undefined && result.envFile.length > 0) {
        io.stdout(`env: ${result.envFile}\n`);
      }
      if (result !== undefined && result.services.length > 0) {
        for (const service of result.services) {
          io.stdout(`  ${service.name}: ${service.url}\n`);
        }
      }
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
