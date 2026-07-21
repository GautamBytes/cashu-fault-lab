import {
  renderHtml,
  renderJson,
  renderJunit,
  renderMatrixHtml,
  renderMatrixJson,
  renderMatrixJunit,
} from '@cashu-fault-lab/report';
import { validateScenarioSpec } from '@cashu-fault-lab/adapter-contract';
import {
  assertReplayableArtifact,
  type FailureArtifact,
  type MatrixCaseResult,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { Command, CommanderError, Option } from 'commander';
import { chmod, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseAdapterManifest, type AdapterManifest } from './adapter-manifest.js';
import { PackagedLabRuntime } from './packaged-runtime.js';

const DEFAULT_ARTIFACT_PATH = 'artifacts/latest.json';

export interface LabSelection {
  readonly sender: string;
  readonly receiver: string;
  readonly adapterManifest?: AdapterManifest;
}

export interface LabRuntime {
  up(profile: string): Promise<void>;
  down(profile: string): Promise<void>;
  run(scenario: ScenarioSpec, seed: string, selection?: LabSelection): Promise<ScenarioRunResult>;
  replay(artifact: FailureArtifact): Promise<ScenarioRunResult>;
  shrink(artifact: FailureArtifact, runLimit?: number): Promise<ScenarioRunResult>;
  matrix(
    profile: string,
    seed: string,
    adapterManifest?: AdapterManifest,
  ): Promise<readonly MatrixCaseResult[]>;
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
  readonly doctorProbes?: import('./doctor.js').DoctorProbes;
}

export interface CliOutcome {
  readonly exitCode: 0 | 1 | 2;
}

const defaultIo: CliIo = {
  readText: async (path) => readFile(path, 'utf8'),
  writeText: async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
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
  const validation = validateScenarioSpec(value);
  if (!validation.ok) {
    throw new Error(
      `Scenario file is invalid: ${validation.errorCode} at ${validation.path || '<root>'} — ${validation.message}`,
    );
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

async function readAdapterManifest(
  io: CliIo,
  path: string | undefined,
): Promise<AdapterManifest | undefined> {
  if (path === undefined) return undefined;
  return parseAdapterManifest(json(await io.readText(path)));
}

function elapsed(start: number): string {
  const ms = Date.now() - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function verboseLine(verbose: boolean, io: CliIo, value: string): void {
  if (verbose) io.stdout(`${value}\n`);
}

export async function runCli(
  argv: readonly string[],
  dependencies: RunCliDependencies = {},
): Promise<CliOutcome> {
  const io = dependencies.io ?? defaultIo;
  const runtime = dependencies.runtime ?? new PackagedLabRuntime();
  const doctorProbes = dependencies.doctorProbes;
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
    .command('down')
    .description('Stop the local lab services')
    .option('--profile <profile>', 'compose profile', 'lab')
    .action(async (options: { profile: string }) => {
      await runtime.down(options.profile);
      io.stdout(`stopped ${options.profile}\n`);
    });

  program
    .command('run')
    .description('Run one scenario')
    .argument('<scenario>', 'scenario JSON file path (e.g. retry/response-lost)')
    .option('--seed <seed>', 'deterministic seed', 'cashu-fault-lab')
    .option('--artifact <path>', 'write replayable result artifact')
    .option('--sender <adapter>', 'sender adapter', 'reference-ts')
    .option('--receiver <adapter>', 'receiver adapter', 'reference-ts')
    .option('--adapters <path>', 'external adapter manifest')
    .option('--verbose', 'print progress for each command', false)
    .action(
      async (
        path: string,
        options: {
          seed: string;
          artifact?: string;
          sender: string;
          receiver: string;
          adapters?: string;
          verbose: boolean;
        },
      ) => {
        const spec = scenario(json(await readScenario(io, path)));
        const adapterManifest = await readAdapterManifest(io, options.adapters);
        const start = Date.now();

        if (options.verbose) {
          io.stdout(`scenario: ${spec.name}\n`);
          io.stdout(`seed: ${options.seed}\n`);
          io.stdout(`sender: ${options.sender}  receiver: ${options.receiver}\n`);
        }

        for (let i = 0; i < spec.commands.length; i++) {
          const cmd = spec.commands[i]!;
          const label =
            cmd.type === 'configure_fault'
              ? `configure_fault: ${cmd.target} ${cmd.rule.kind}${cmd.rule.occurrence !== undefined ? ` (occurrence: ${cmd.rule.occurrence})` : ''}`
              : cmd.type === 'send'
                ? `send: ${cmd.sender} request ${cmd.requestId}`
                : cmd.type === 'restart'
                  ? `restart: ${cmd.component}`
                  : cmd.type === 'clear_faults'
                    ? `clear_faults${cmd.target !== undefined ? ` (${cmd.target})` : ''}`
                    : cmd.type === 'advance_time'
                      ? `advance_time: ${cmd.milliseconds}ms`
                      : cmd.type === 'assert_quiescent'
                        ? 'assert_quiescent'
                        : `unknown: ${JSON.stringify(cmd)}`;
          verboseLine(options.verbose, io, `[${i + 1}/${spec.commands.length}] ${label}`);
        }

        const result = await runtime.run(spec, options.seed, {
          sender: options.sender,
          receiver: options.receiver,
          ...(adapterManifest === undefined ? {} : { adapterManifest }),
        });
        await io.writeText(options.artifact ?? DEFAULT_ARTIFACT_PATH, resultArtifact(result));
        io.stdout(
          `${result.status} ${result.artifact.scenario} seed=${result.artifact.seed} (${elapsed(start)})\n`,
        );
        if (result.status === 'failed') exitCode = 1;
      },
    );

  program
    .command('replay')
    .description('Replay a deterministic failure artifact')
    .argument('<artifact>', 'artifact JSON file')
    .option('--artifact <path>', 'write the new result artifact')
    .option('--verbose', 'print progress for each command', false)
    .action(async (path: string, options: { artifact?: string; verbose: boolean }) => {
      const decoded = json(await io.readText(path));
      const source =
        isRecord(decoded) && 'artifact' in decoded
          ? runResult(decoded).artifact
          : artifact(decoded);
      verboseLine(options.verbose, io, `replay: ${source.scenario} seed=${source.seed}`);
      verboseLine(options.verbose, io, `commands: ${source.commands.length}`);
      const start = Date.now();
      const result = await runtime.replay(source);
      await maybeWrite(io, options.artifact, resultArtifact(result));
      io.stdout(
        `${result.status} ${result.artifact.scenario} seed=${result.artifact.seed} (${elapsed(start)})\n`,
      );
      if (result.status === 'failed') exitCode = 1;
    });

  program
    .command('shrink')
    .description('Minimize a failing artifact to the smallest reproducing command set')
    .argument('<artifact>', 'artifact JSON file')
    .option('--artifact <path>', 'write the minimized result artifact')
    .option('--run-limit <count>', 'maximum shrink probe runs', '100')
    .option('--verbose', 'print minimization progress', false)
    .action(
      async (path: string, options: { artifact?: string; runLimit: string; verbose: boolean }) => {
        const limit = Number(options.runLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
          throw new Error('Shrink run limit must be a positive safe integer');
        }
        const decoded = json(await io.readText(path));
        const source =
          isRecord(decoded) && 'artifact' in decoded
            ? runResult(decoded).artifact
            : artifact(decoded);
        verboseLine(options.verbose, io, `shrink: ${source.scenario} seed=${source.seed}`);
        verboseLine(
          options.verbose,
          io,
          `commands: ${source.commands.length} (run limit ${limit})`,
        );
        const start = Date.now();
        let result: ScenarioRunResult;
        try {
          result = await runtime.shrink(source, limit);
        } catch (error) {
          io.stderr(`${safeError(error)}\n`);
          return;
        }
        await maybeWrite(io, options.artifact, resultArtifact(result));
        const reduction =
          result.artifact.commands.length < source.commands.length
            ? ` (${source.commands.length} -> ${result.artifact.commands.length})`
            : '';
        io.stdout(
          `${result.status} ${result.artifact.scenario} seed=${result.artifact.seed}${reduction} (${elapsed(start)})\n`,
        );
        if (result.status === 'failed') exitCode = 1;
      },
    );

  program
    .command('diff')
    .description('Compare two scenario result artifacts and print the structured differences')
    .argument('<left>', 'left (baseline) artifact JSON file')
    .argument('<right>', 'right (candidate) artifact JSON file')
    .option('--json', 'emit machine-readable JSON instead of text', false)
    .action(async (leftPath: string, rightPath: string, options: { json: boolean }) => {
      const left = runResult(json(await io.readText(leftPath)));
      const right = runResult(json(await io.readText(rightPath)));
      const { diffScenarios, renderDiffText } = await import('./diff.js');
      const diff = diffScenarios(left, right);
      if (options.json) {
        io.stdout(`${JSON.stringify(diff, null, 2)}\n`);
      } else {
        io.stdout(renderDiffText(leftPath, rightPath, left, right, diff));
      }
      if (!diff.sameOutcome) exitCode = 1;
    });

  program
    .command('matrix')
    .description('Run the sender/receiver compatibility matrix')
    .option(
      '--profile <profile>',
      'matrix profile (delivery-v1, legacy-nut18, nut26-nostr)',
      'delivery-v1',
    )
    .option('--seed <seed>', 'deterministic seed', 'cashu-fault-lab')
    .option('--min-passes <count>', 'minimum passing pairs required')
    .option('--adapters <path>', 'external adapter manifest')
    .addOption(
      new Option('--format <format>', 'report format for full matrix output')
        .choices(['text', 'json', 'junit', 'html'])
        .default('text'),
    )
    .option('--output <path>', 'write the formatted matrix report to a file')
    .option('--verbose', 'print per-pair results', false)
    .action(
      async (options: {
        profile: string;
        seed: string;
        minPasses?: string;
        adapters?: string;
        format: 'text' | 'json' | 'junit' | 'html';
        output?: string;
        verbose: boolean;
      }) => {
        const minimum = options.minPasses === undefined ? 0 : Number(options.minPasses);
        if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 10_000) {
          throw new Error('Minimum matrix passes must be a nonnegative safe integer');
        }
        verboseLine(options.verbose, io, `profile: ${options.profile}`);
        verboseLine(options.verbose, io, `seed: ${options.seed}`);
        const start = Date.now();
        const adapterManifest = await readAdapterManifest(io, options.adapters);
        const results = await runtime.matrix(options.profile, options.seed, adapterManifest);

        if (options.verbose || options.format === 'text') {
          for (const result of results) {
            const icon = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '—';
            io.stdout(
              `  ${icon} ${result.sender} → ${result.receiver}: ${result.status}${result.status === 'failed' && result.reason ? ` (${result.reason})` : ''}\n`,
            );
          }
        }

        const passed = results.filter((result) => result.status === 'passed').length;
        const failed = results.filter((result) => result.status === 'failed').length;
        const notApplicable = results.filter((result) => result.status === 'not_applicable').length;
        const expected = results.filter((result) => result.status === 'expected_failure').length;
        if (options.format === 'text') {
          io.stdout(
            `matrix ${options.profile}: ${passed} passed, ${failed} failed, ${notApplicable} N/A, ${expected} expected-failure (${elapsed(start)})\n`,
          );
        } else {
          const matrixInput = { profile: options.profile, seed: options.seed, results };
          const rendered =
            options.format === 'html'
              ? renderMatrixHtml(matrixInput)
              : options.format === 'junit'
                ? renderMatrixJunit(matrixInput)
                : renderMatrixJson(matrixInput);
          if (options.output) await io.writeText(options.output, rendered);
          else io.stdout(rendered);
        }
        if (failed > 0) exitCode = 1;
        if (passed < minimum) {
          io.stderr(
            `matrix ${options.profile} requires at least ${minimum} passing pairs; observed ${passed}\n`,
          );
          exitCode = 1;
        }
      },
    );

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

  program
    .command('ls')
    .description('List all available scenarios')
    .option('--json', 'output JSON', false)
    .action(async (options: { json: boolean }) => {
      const root = 'scenarios';
      const entries: { path: string; name: string; description?: string }[] = [];

      let dirExists = false;
      try {
        await readdir(root);
        dirExists = true;
      } catch {
        // scenarios/ directory not found
      }

      if (dirExists) {
        const walk = async (dir: string) => {
          const items = await readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const full = join(dir, item.name);
            if (item.isDirectory()) {
              await walk(full);
            } else if (item.name.endsWith('.json')) {
              try {
                const raw = await readFile(full, 'utf8');
                const spec = JSON.parse(raw) as { name: string; description?: string };
                if (typeof spec.name === 'string') {
                  entries.push({
                    path: relative(root, full).replace(/\\/g, '/'),
                    name: spec.name,
                    ...(typeof spec.description === 'string'
                      ? { description: spec.description }
                      : {}),
                  });
                }
              } catch {
                // Skip unparseable files
              }
            }
          }
        };
        await walk(root);
      }

      if (options.json) {
        io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
      } else {
        if (entries.length === 0) {
          io.stdout('no scenarios found — run from the repository root\n');
        } else {
          for (const entry of entries) {
            const desc = entry.description ? `  — ${entry.description}` : '';
            io.stdout(`${entry.path}  (${entry.name})${desc}\n`);
          }
        }
      }
    });

  program
    .command('inspect')
    .description('Pretty-print a scenario file')
    .argument('<scenario>', 'scenario JSON file path (e.g. retry/response-lost)')
    .action(async (path: string) => {
      const raw = await readScenario(io, path);
      const spec = scenario(json(raw));
      const output: Record<string, unknown> = {};
      output.name = spec.name;
      output.commands = spec.commands;
      io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    });

  program
    .command('validate')
    .description('Validate a scenario file against the scenario-spec schema')
    .argument('<scenario>', 'scenario JSON file path (e.g. retry/response-lost)')
    .action(async (path: string) => {
      const raw = await readScenario(io, path);
      const value = json(raw);
      const validation = validateScenarioSpec(value);
      if (validation.ok) {
        const spec = value as unknown as ScenarioSpec;
        io.stdout(`ok ${spec.name} (${spec.commands.length} commands)\n`);
        return;
      }
      io.stderr(
        `invalid: ${validation.errorCode} at ${validation.path || '<root>'} — ${validation.message}\n`,
      );
      exitCode = 1;
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
      const { runDoctor, defaultDoctorProbes } = await import('./doctor.js');
      const report = await runDoctor(doctorProbes ?? defaultDoctorProbes());
      if (options.json) {
        io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        for (const check of report.checks) {
          const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
          io.stdout(`  ${icon} ${check.name}: ${check.detail}\n`);
        }
        const failedCount = report.checks.filter((c) => c.status === 'fail').length;
        const warnCount = report.checks.filter((c) => c.status === 'warn').length;
        io.stdout(
          `\ndoctor: ${report.checks.length} checks, ${failedCount} failed, ${warnCount} warned\n`,
        );
      }
      if (!report.ok) exitCode = 1;
    });

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
