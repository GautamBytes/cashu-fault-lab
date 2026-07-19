import { renderHtml, renderJson, renderJunit } from '@cashu-fault-lab/report';
import {
  assertReplayableArtifact,
  type FailureArtifact,
  type MatrixCaseResult,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { Command, CommanderError, Option } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PackagedLabRuntime } from './packaged-runtime.js';

const DEFAULT_ARTIFACT_PATH = 'artifacts/latest.json';

export interface LabSelection {
  readonly sender: string;
  readonly receiver: string;
}

export interface LabRuntime {
  up(profile: string): Promise<void>;
  run(scenario: ScenarioSpec, seed: string, selection?: LabSelection): Promise<ScenarioRunResult>;
  replay(artifact: FailureArtifact): Promise<ScenarioRunResult>;
  matrix(profile: string, seed: string): Promise<readonly MatrixCaseResult[]>;
}

export interface CliIo {
  readonly readText: (path: string) => Promise<string>;
  readonly writeText: (path: string, value: string) => Promise<void>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface RunCliDependencies {
  readonly runtime?: LabRuntime;
  readonly io?: CliIo;
}

export interface CliOutcome {
  readonly exitCode: 0 | 1 | 2;
}

const defaultIo: CliIo = {
  readText: async (path) => readFile(path, 'utf8'),
  writeText: async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
  },
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Input is not valid JSON');
  }
}

function scenario(value: unknown): ScenarioSpec {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.commands)) {
    throw new Error('Scenario file is invalid');
  }
  return value as unknown as ScenarioSpec;
}

function artifact(value: unknown): FailureArtifact {
  if (!isRecord(value)) throw new Error('Replay artifact is invalid');
  const candidate = value as unknown as FailureArtifact;
  assertReplayableArtifact(candidate);
  return candidate;
}

function runResult(value: unknown): ScenarioRunResult {
  if (!isRecord(value) || (value.status !== 'passed' && value.status !== 'failed')) {
    throw new Error('Scenario result artifact is invalid');
  }
  const parsedArtifact = artifact(value.artifact);
  if (value.status === 'failed') {
    if (
      !isRecord(value.error) ||
      typeof value.error.name !== 'string' ||
      typeof value.error.message !== 'string'
    ) {
      throw new Error('Failed scenario result has no valid error');
    }
    return {
      status: 'failed',
      artifact: parsedArtifact,
      error: { name: value.error.name, message: value.error.message },
    };
  }
  return { status: 'passed', artifact: parsedArtifact };
}

function resultArtifact(result: ScenarioRunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Command failed';
  return error.message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:cashu[AB]|nsec1)[A-Za-z0-9_-]+/gi, '[REDACTED]');
}

async function maybeWrite(io: CliIo, path: string | undefined, value: string): Promise<void> {
  if (path) await io.writeText(path, value);
}

async function readScenario(io: CliIo, path: string): Promise<string> {
  const candidates = [path, ...(!path.endsWith('.json') ? [`scenarios/${path}.json`] : [])];
  for (const candidate of candidates) {
    try {
      return await io.readText(candidate);
    } catch {
      // Try the packaged shorthand path before returning a stable error.
    }
  }
  throw new Error(`Scenario file was not found: ${path}`);
}

export async function runCli(
  argv: readonly string[],
  dependencies: RunCliDependencies = {},
): Promise<CliOutcome> {
  const io = dependencies.io ?? defaultIo;
  const runtime = dependencies.runtime ?? new PackagedLabRuntime();
  let exitCode: CliOutcome['exitCode'] = 0;
  const program = new Command()
    .name('cashu-fault-lab')
    .description('Deterministic Cashu payment delivery fault laboratory')
    .version('0.0.0')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command('up')
    .description('Start the local lab services')
    .option('--profile <profile>', 'compose profile', 'lab')
    .action(async (options: { profile: string }) => {
      await runtime.up(options.profile);
      io.stdout(`started ${options.profile}\n`);
    });

  program
    .command('run')
    .description('Run one scenario')
    .argument('<scenario>', 'scenario JSON file')
    .option('--seed <seed>', 'deterministic seed', 'cashu-fault-lab')
    .option('--artifact <path>', 'write replayable result artifact')
    .option('--sender <adapter>', 'sender adapter', 'reference-ts')
    .option('--receiver <adapter>', 'receiver adapter', 'reference-ts')
    .action(
      async (
        path: string,
        options: { seed: string; artifact?: string; sender: string; receiver: string },
      ) => {
        const spec = scenario(json(await readScenario(io, path)));
        const result = await runtime.run(spec, options.seed, {
          sender: options.sender,
          receiver: options.receiver,
        });
        await io.writeText(options.artifact ?? DEFAULT_ARTIFACT_PATH, resultArtifact(result));
        io.stdout(`${result.status} ${result.artifact.scenario} seed=${result.artifact.seed}\n`);
        if (result.status === 'failed') exitCode = 1;
      },
    );

  program
    .command('replay')
    .description('Replay a deterministic failure artifact')
    .argument('<artifact>', 'artifact JSON file')
    .option('--artifact <path>', 'write the new result artifact')
    .action(async (path: string, options: { artifact?: string }) => {
      const decoded = json(await io.readText(path));
      const source =
        isRecord(decoded) && 'artifact' in decoded
          ? runResult(decoded).artifact
          : artifact(decoded);
      const result = await runtime.replay(source);
      await maybeWrite(io, options.artifact, resultArtifact(result));
      io.stdout(`${result.status} ${result.artifact.scenario} seed=${result.artifact.seed}\n`);
      if (result.status === 'failed') exitCode = 1;
    });

  program
    .command('matrix')
    .description('Run the sender/receiver compatibility matrix')
    .option('--profile <profile>', 'matrix profile', 'delivery-v1')
    .option('--seed <seed>', 'deterministic seed', 'cashu-fault-lab')
    .action(async (options: { profile: string; seed: string }) => {
      const results = await runtime.matrix(options.profile, options.seed);
      const passed = results.filter((result) => result.status === 'passed').length;
      const failed = results.filter((result) => result.status === 'failed').length;
      const notApplicable = results.filter((result) => result.status === 'not_applicable').length;
      const expected = results.filter((result) => result.status === 'expected_failure').length;
      io.stdout(
        `matrix ${options.profile}: ${passed} passed, ${failed} failed, ${notApplicable} N/A, ${expected} expected-failure\n`,
      );
      if (failed > 0) exitCode = 1;
    });

  program
    .command('report')
    .description('Render a redacted scenario report')
    .argument('[artifact]', 'scenario result JSON file', DEFAULT_ARTIFACT_PATH)
    .addOption(
      new Option('--format <format>', 'report format')
        .choices(['json', 'junit', 'html'])
        .default('json'),
    )
    .option('--output <path>', 'write report to a file')
    .action(
      async (path: string, options: { format: 'json' | 'junit' | 'html'; output?: string }) => {
        const result = runResult(json(await io.readText(path)));
        const rendered =
          options.format === 'html'
            ? renderHtml({ result })
            : options.format === 'junit'
              ? renderJunit({ result })
              : renderJson({ result });
        if (options.output) await io.writeText(options.output, rendered);
        else io.stdout(rendered);
      },
    );

  try {
    await program.parseAsync([...argv], { from: 'node' });
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      return { exitCode: 0 };
    }
    io.stderr(`${safeError(error)}\n`);
    return { exitCode: 2 };
  }
  return { exitCode };
}
