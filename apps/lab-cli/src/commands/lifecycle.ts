import { Option, type Command } from 'commander';
import {
  renderLifecycleHtml,
  renderLifecycleJson,
  renderLifecycleJunit,
  type LifecycleReportInput,
} from '@cashu-fault-lab/report';
import {
  lifecycleSeedHash,
  validateLifecycleScenarioSpec,
  type LifecycleFailureArtifact,
  type LifecycleReplayResult,
  type LifecycleScenarioRunResult,
  type LifecycleScenarioSpec,
} from '@cashu-fault-lab/wallet-lifecycle-runner';
import type { DoctorProbes } from '../doctor.js';
import { defaultDoctorProbes, runDoctor } from '../doctor.js';
import { LabDiagnosticError } from '../diagnostics.js';
import type { CliIo, CliOutcome, LabRuntime } from '../index.js';
import { runtimeAssetPath } from '../runtime-assets.js';

export interface LifecycleCommandContext {
  readonly io: CliIo;
  readonly runtime: LabRuntime;
  readonly distribution: 'workspace' | 'package';
  readonly doctorProbes?: DoctorProbes;
  readonly lifecycleRuntime?: LifecycleLabRuntime;
  readonly setExitCode: (exitCode: CliOutcome['exitCode']) => void;
}

export interface LifecycleRunOptions {
  readonly scenario: LifecycleScenarioSpec;
  readonly seed: string;
  readonly adapterId: string;
  readonly mintId: string;
  readonly mintUrl?: string;
}

export interface LifecycleRunExecution {
  readonly result: LifecycleScenarioRunResult;
  readonly componentVersions?: Readonly<Record<string, string>>;
  readonly imageDigests?: Readonly<Record<string, string>>;
}

export interface LifecycleMatrixCliResult {
  readonly id: string;
  readonly implementationId: string;
  readonly mintId: string;
  readonly status: 'passed' | 'failed' | 'not_applicable';
  readonly code?: string;
  readonly reason?: string;
}

export interface LifecycleLabRuntime {
  run(input: LifecycleRunOptions): Promise<LifecycleRunExecution>;
  matrix(input: {
    readonly profile: string;
    readonly seed: string;
  }): Promise<readonly LifecycleMatrixCliResult[]>;
  replay(input: {
    readonly artifact: LifecycleFailureArtifact;
    readonly seed: string;
    readonly adapterId: string;
    readonly mintId: string;
  }): Promise<LifecycleReplayResult>;
}

const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_SCENARIO_BYTES = 512 * 1_024;
const MAX_REPLAY_ARTIFACT_BYTES = 4 * 1_024 * 1_024;

function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Lifecycle input is not valid JSON');
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Lifecycle input must be an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

async function readScenario(
  io: CliIo,
  path: string,
  distribution: LifecycleCommandContext['distribution'],
): Promise<LifecycleScenarioSpec> {
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) {
    throw new Error('Lifecycle scenario path is invalid');
  }
  const workspaceCandidates = SCENARIO_ID.test(path)
    ? [`scenarios/wallet-lifecycle/${path}.json`]
    : [path.endsWith('.json') ? path : `${path}.json`];
  const candidates =
    distribution === 'package'
      ? workspaceCandidates.flatMap((candidate) => [runtimeAssetPath(candidate), candidate])
      : workspaceCandidates;
  let raw: string | undefined;
  for (const candidate of candidates) {
    try {
      raw = await io.readText(candidate);
      break;
    } catch {
      // Continue to the stable not-found error.
    }
  }
  if (raw === undefined) throw new Error(`Lifecycle scenario was not found: ${path}`);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SCENARIO_BYTES) {
    throw new Error('Lifecycle scenario exceeds the size limit');
  }
  const value = json(raw);
  const validation = validateLifecycleScenarioSpec(value);
  if (!validation.ok) {
    throw new Error(
      `Lifecycle scenario is invalid at ${validation.path || '<root>'}: ${validation.message}`,
    );
  }
  return value as LifecycleScenarioSpec;
}

function failureArtifact(value: unknown): LifecycleFailureArtifact {
  const wrapper = record(value);
  const candidate =
    wrapper.schemaVersion === 1 &&
    wrapper.suite === 'wallet-lifecycle-v1' &&
    wrapper.status === 'failed'
      ? wrapper.replayArtifact
      : value;
  const input = record(candidate);
  if (
    input.schemaVersion !== 2 ||
    typeof input.redacted !== 'boolean' ||
    !Array.isArray(input.history) ||
    !Array.isArray(input.observations) ||
    typeof input.scenario !== 'object' ||
    input.scenario === null ||
    typeof input.failure !== 'object' ||
    input.failure === null
  ) {
    throw new Error('Lifecycle replay artifact is invalid');
  }
  const scenario = input.scenario as Readonly<Record<string, unknown>>;
  const failure = input.failure as Readonly<Record<string, unknown>>;
  if (
    typeof scenario.id !== 'string' ||
    typeof scenario.seedHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(scenario.seedHash) ||
    typeof scenario.requireQuiescence !== 'boolean' ||
    !Array.isArray(scenario.commands) ||
    scenario.commands.length === 0 ||
    scenario.commands.length > 1_000 ||
    input.history.length > 2_000 ||
    input.observations.length > 20_000 ||
    !Number.isSafeInteger(failure.commandIndex) ||
    (failure.code !== 'LIFECYCLE_DRIVER' && failure.code !== 'LIFECYCLE_INVARIANT') ||
    typeof failure.message !== 'string' ||
    (failure.detailHash !== undefined &&
      (typeof failure.detailHash !== 'string' || !DIGEST.test(failure.detailHash)))
  ) {
    throw new Error('Lifecycle replay artifact is invalid');
  }
  const requiredOperations = [
    ...new Set(
      scenario.commands.flatMap((command) => {
        const entry = record(command);
        if (entry.type !== 'start') return [];
        const operationInput = record(entry.input);
        return typeof operationInput.kind === 'string' ? [operationInput.kind] : [];
      }),
    ),
  ];
  const validation = validateLifecycleScenarioSpec({
    schemaVersion: 1,
    id: scenario.id,
    seed: 'lifecycle-replay-validation',
    requiredOperations: requiredOperations.length === 0 ? ['restore'] : requiredOperations,
    requireQuiescence: scenario.requireQuiescence,
    commands: scenario.commands,
  });
  if (!validation.ok) throw new Error('Lifecycle replay artifact commands are invalid');
  return candidate as unknown as LifecycleFailureArtifact;
}

function runtime(context: LifecycleCommandContext): LifecycleLabRuntime {
  if (context.lifecycleRuntime === undefined) {
    throw new Error('Lifecycle runtime is not configured');
  }
  return context.lifecycleRuntime;
}

export function registerLifecycleCommands(
  program: Command,
  context: LifecycleCommandContext,
): void {
  const { io, runtime: labRuntime, distribution, doctorProbes, setExitCode } = context;

  program
    .command('up')
    .description('Start the local lab services')
    .option('--profile <profile>', 'compose profile', 'lab')
    .action(async (options: { profile: string }) => {
      const startup = await runDoctor(doctorProbes ?? defaultDoctorProbes(), {
        environment: false,
        senderDurability: false,
        pnpm: distribution === 'workspace',
        cargo: false,
        dockerCompose: distribution === 'package',
        testcontainers: distribution === 'workspace',
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
        result = await labRuntime.up(options.profile);
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
      await labRuntime.down(options.profile);
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
    .addOption(
      new Option('--suite <suite>', 'limit checks to a lab suite')
        .choices(['all', 'lifecycle'])
        .default('all'),
    )
    .action(async (options: { json: boolean; suite: 'all' | 'lifecycle' }) => {
      const lifecycleOptions =
        options.suite === 'lifecycle'
          ? { lifecycle: true, senderDurability: false, testTiers: false }
          : {};
      const report = await runDoctor(
        doctorProbes ?? defaultDoctorProbes(),
        distribution === 'package'
          ? {
              ...lifecycleOptions,
              environment: options.suite === 'lifecycle',
              senderDurability: false,
              pnpm: false,
              cargo: false,
              dockerCompose: true,
              testcontainers: false,
              testTiers: false,
            }
          : lifecycleOptions,
      );
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

  const lifecycle = program
    .command('lifecycle')
    .description('Run wallet lifecycle fault, replay, and compatibility workflows');

  lifecycle
    .command('run')
    .description('Run one wallet lifecycle scenario')
    .argument('<scenario>', 'packaged lifecycle scenario ID or relative JSON path')
    .requiredOption('--adapter <id>', 'lifecycle adapter ID')
    .requiredOption('--mint <id>', 'test mint identity')
    .option('--mint-url <url>', 'override the scenario mint URL')
    .option('--seed <seed>', 'deterministic seed', 'cashu-fault-lab-lifecycle')
    .addOption(
      new Option('--format <format>', 'redacted lifecycle report format')
        .choices(['json', 'junit', 'html'])
        .default('json'),
    )
    .option('--output <path>', 'write the redacted lifecycle report')
    .option('--artifact <path>', 'legacy alias for --output with JSON format')
    .action(
      async (
        path: string,
        options: {
          adapter: string;
          mint: string;
          mintUrl?: string;
          seed: string;
          format: 'json' | 'junit' | 'html';
          output?: string;
          artifact?: string;
        },
      ) => {
        if (options.artifact !== undefined && options.output !== undefined) {
          throw new Error('Use either --artifact or --output, not both');
        }
        if (options.artifact !== undefined && options.format !== 'json') {
          throw new Error('--artifact is only compatible with JSON format');
        }
        const source = await readScenario(io, path, distribution);
        const scenario: LifecycleScenarioSpec = {
          ...source,
          seed: options.seed,
          commands:
            options.mintUrl === undefined
              ? source.commands
              : source.commands.map((command) =>
                  command.type === 'start'
                    ? { ...command, input: { ...command.input, mint: options.mintUrl! } }
                    : command,
                ),
        };
        const execution = await runtime(context).run({
          scenario,
          seed: options.seed,
          adapterId: options.adapter,
          mintId: options.mint,
          ...(options.mintUrl === undefined ? {} : { mintUrl: options.mintUrl }),
        });
        const reportInput: LifecycleReportInput = {
          scenario,
          result: execution.result,
          adapterId: options.adapter,
          mintId: options.mint,
          ...(execution.componentVersions === undefined
            ? {}
            : { componentVersions: execution.componentVersions }),
          ...(execution.imageDigests === undefined ? {} : { imageDigests: execution.imageDigests }),
        };
        const rendered =
          options.format === 'junit'
            ? renderLifecycleJunit(reportInput)
            : options.format === 'html'
              ? renderLifecycleHtml(reportInput)
              : renderLifecycleJson(reportInput);
        const extension = options.format === 'junit' ? 'xml' : options.format;
        const output =
          options.output ?? options.artifact ?? `artifacts/lifecycle/${scenario.id}.${extension}`;
        await io.writeText(output, rendered);
        const status = execution.result.ok ? 'passed' : 'failed';
        io.stdout(
          `${status} ${scenario.id} seedHash=${lifecycleSeedHash(options.seed)} report=${output}\n`,
        );
        if (!execution.result.ok) setExitCode(1);
      },
    );

  lifecycle
    .command('matrix')
    .description('Run the wallet lifecycle compatibility matrix')
    .option('--profile <profile>', 'lifecycle matrix profile', 'wallet-lifecycle-v1')
    .option('--seed <seed>', 'deterministic seed', 'cashu-fault-lab-lifecycle')
    .option('--json', 'emit machine-readable matrix results', false)
    .option('--output <path>', 'write matrix output to a file')
    .action(async (options: { profile: string; seed: string; json: boolean; output?: string }) => {
      if (options.profile !== 'wallet-lifecycle-v1') {
        throw new Error('Lifecycle matrix profile is unsupported');
      }
      const results = await runtime(context).matrix({
        profile: options.profile,
        seed: options.seed,
      });
      const passed = results.filter(({ status }) => status === 'passed').length;
      const failed = results.filter(({ status }) => status === 'failed').length;
      const notApplicable = results.filter(({ status }) => status === 'not_applicable').length;
      const rendered = options.json
        ? `${JSON.stringify(
            {
              schemaVersion: 1,
              profile: options.profile,
              seedHash: lifecycleSeedHash(options.seed),
              results,
              summary: { passed, failed, notApplicable },
            },
            null,
            2,
          )}\n`
        : `${results
            .map((result) => {
              const label = result.status === 'not_applicable' ? 'N/A' : result.status;
              return `  ${result.id} @ ${result.mintId}: ${label}${result.reason === undefined ? '' : ` (${result.reason})`}`;
            })
            .join(
              '\n',
            )}\nmatrix ${options.profile}: ${passed} passed, ${failed} failed, ${notApplicable} N/A\n`;
      if (options.output === undefined) io.stdout(rendered);
      else await io.writeText(options.output, rendered);
      if (results.length === 0) {
        io.stderr('lifecycle matrix produced no runnable lanes\n');
        setExitCode(1);
      } else if (failed > 0) setExitCode(1);
    });

  lifecycle
    .command('replay')
    .description('Replay an exact wallet lifecycle failure')
    .argument('<artifact>', 'lifecycle failure artifact JSON')
    .requiredOption('--seed <seed>', 'original deterministic seed supplied out of band')
    .requiredOption('--adapter <id>', 'lifecycle adapter ID')
    .requiredOption('--mint <id>', 'test mint identity')
    .action(async (path: string, options: { seed: string; adapter: string; mint: string }) => {
      const raw = await io.readText(path);
      if (Buffer.byteLength(raw, 'utf8') > MAX_REPLAY_ARTIFACT_BYTES) {
        throw new Error('Lifecycle replay artifact exceeds the size limit');
      }
      const artifact = failureArtifact(json(raw));
      if (lifecycleSeedHash(options.seed) !== artifact.scenario.seedHash) {
        throw new Error('Lifecycle replay seed does not match the artifact');
      }
      const result = await runtime(context).replay({
        artifact,
        seed: options.seed,
        adapterId: options.adapter,
        mintId: options.mint,
      });
      io.stdout(`${result.matched ? 'matched' : 'mismatch'} ${artifact.scenario.id}\n`);
      if (!result.matched) setExitCode(1);
    });
}
