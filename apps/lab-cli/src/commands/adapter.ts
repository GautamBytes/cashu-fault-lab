import { Command, Option } from 'commander';
import {
  scaffoldAdapterProject,
  supportedAdapterLanguages,
  type AdapterTemplateLanguage,
  type AdapterTemplateRole,
} from '../adapter-init.js';
import type { AdapterManifest } from '../adapter-manifest.js';
import type { AdapterPreflightReport } from '../adapter-preflight.js';
import type { CliIo, CliOutcome } from '../index.js';
import { basename, join } from 'node:path';

export interface AdapterPreflightCommandOptions {
  readonly profile: string;
  readonly adapterId?: string;
}

export interface AdapterPreviewCommandOptions {
  readonly profile: string;
  readonly seed: string;
  readonly sender: string;
  readonly receiver: string;
}

export interface AdapterPreviewCommandResult {
  readonly status: 'passed' | 'failed' | 'expected_failure' | 'not_applicable';
  readonly artifacts: ReadonlyMap<string, string>;
}

export interface AdapterCommandContext {
  readonly io: CliIo;
  readonly loadManifest: (path: string) => Promise<AdapterManifest>;
  readonly preflight: (
    manifest: AdapterManifest,
    options: AdapterPreflightCommandOptions,
  ) => Promise<AdapterPreflightReport>;
  readonly preview: (
    manifest: AdapterManifest,
    options: AdapterPreviewCommandOptions,
  ) => Promise<AdapterPreviewCommandResult>;
  readonly setExitCode: (code: CliOutcome['exitCode']) => void;
}

function renderPreflightText(report: AdapterPreflightReport): string {
  const lines = [`adapter preflight ${report.ok ? 'passed' : 'failed'} profile=${report.profile}`];
  for (const check of report.checks) {
    const marker = check.status === 'passed' ? '✓' : check.status === 'warning' ? '!' : '✗';
    lines.push(
      `${marker} ${check.adapterId} ${check.code}: ${check.message}`,
      ...(check.remediation === undefined ? [] : [`  fix: ${check.remediation}`]),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function registerAdapterCommands(program: Command, context: AdapterCommandContext): void {
  const adapter = new Command('adapter').description('Manage standalone wallet adapter projects');

  adapter
    .command('init')
    .description('Scaffold a standalone wallet adapter project')
    .addOption(
      new Option('--language <language>', 'template language')
        .choices([...supportedAdapterLanguages])
        .makeOptionMandatory(),
    )
    .requiredOption('--name <name>', 'adapter project name')
    .addOption(
      new Option('--role <role>', 'adapter role')
        .choices(['sender', 'receiver', 'both'])
        .default('both'),
    )
    .option('--output <path>', 'output directory')
    .action(
      async (options: {
        language: AdapterTemplateLanguage;
        name: string;
        role: AdapterTemplateRole;
        output?: string;
      }) => {
        const result = await scaffoldAdapterProject(options);
        context.io.stdout(
          `created ${result.language} adapter ${result.name} at ${result.output}\n`,
        );
      },
    );

  adapter
    .command('preflight')
    .description('Read-only readiness check for loopback wallet adapters')
    .requiredOption('--adapters <path>', 'local adapter manifest')
    .option('--adapter <id>', 'check only one registered adapter')
    .option('--profile <profile>', 'profile readiness to inspect', 'delivery-v1')
    .option('--json', 'emit a machine-readable preflight report', false)
    .action(
      async (options: { adapters: string; adapter?: string; profile: string; json: boolean }) => {
        const manifest = await context.loadManifest(options.adapters);
        const report = await context.preflight(manifest, {
          profile: options.profile,
          ...(options.adapter === undefined ? {} : { adapterId: options.adapter }),
        });
        context.io.stdout(
          options.json ? `${JSON.stringify(report, null, 2)}\n` : renderPreflightText(report),
        );
        if (!report.ok) context.setExitCode(2);
      },
    );

  adapter
    .command('preview')
    .description('Run a non-qualifying maintainer preview against one loopback adapter pair')
    .requiredOption('--adapters <path>', 'local adapter manifest')
    .requiredOption('--sender <id>', 'sender adapter ID')
    .requiredOption('--receiver <id>', 'receiver adapter ID')
    .option('--profile <profile>', 'delivery profile', 'delivery-v1')
    .option('--seed <seed>', 'deterministic preview seed', 'cashu-fault-lab-maintainer-preview')
    .option('--output-dir <path>', 'preview result directory', 'cashu-fault-results')
    .action(
      async (options: {
        adapters: string;
        sender: string;
        receiver: string;
        profile: string;
        seed: string;
        outputDir: string;
      }) => {
        const manifest = await context.loadManifest(options.adapters);
        const result = await context.preview(manifest, {
          profile: options.profile,
          seed: options.seed,
          sender: options.sender,
          receiver: options.receiver,
        });
        for (const [name, contents] of result.artifacts) {
          if (basename(name) !== name) {
            throw new Error('Adapter preview artifact name must not contain a path');
          }
          await context.io.writeText(join(options.outputDir, name), contents);
        }
        context.io.stdout(
          `maintainer preview ${result.status} pair=${options.sender}->${options.receiver} results=${join(options.outputDir, 'preview.json')}\n`,
        );
        context.io.stdout('This is developer feedback evidence, not release qualification.\n');
        if (result.status !== 'passed') context.setExitCode(1);
      },
    );

  program.addCommand(adapter);
}
