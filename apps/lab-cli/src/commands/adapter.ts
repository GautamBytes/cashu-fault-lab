import { Command, Option } from 'commander';
import {
  scaffoldAdapterProject,
  supportedAdapterLanguages,
  type AdapterTemplateLanguage,
  type AdapterTemplateRole,
} from '../adapter-init.js';
import type { CliIo } from '../index.js';

export interface AdapterCommandContext {
  readonly io: CliIo;
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

  program.addCommand(adapter);
}
