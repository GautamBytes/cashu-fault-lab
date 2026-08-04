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
  evaluateReleasePolicy,
  validateReleasePolicy,
  type FailureArtifact,
  type MatrixCaseResult,
  type ReleasePolicy,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { HttpFaultGateway } from '@cashu-fault-lab/http-fault-gateway';
import { Command, CommanderError, Option } from 'commander';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseAdapterManifest, type AdapterManifest } from './adapter-manifest.js';
import { preflightLocalAdapters, type AdapterPreflightReport } from './adapter-preflight.js';
import { createAdapterPreviewArtifacts, validateLocalFaultGateway } from './adapter-preview.js';
import { registerAdapterCommands } from './commands/adapter.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerWalletDoctorCommands } from './commands/wallet-doctor.js';
import { createEnvironmentLifecycleRuntime } from './lifecycle-runtime.js';
import {
  LabDiagnosticError,
  createDiagnostic,
  renderDiagnosticJson,
  renderDiagnosticText,
} from './diagnostics.js';
import { PackagedLabRuntime } from './packaged-runtime.js';
import { loadReleaseSuite, type LoadedReleaseSuite } from './release-suite-loader.js';
import { runtimeAssetPath } from './runtime-assets.js';

const DEFAULT_ARTIFACT_PATH = 'artifacts/latest.json';

export interface LabSelection {
  readonly sender: string;
  readonly receiver: string;
  readonly adapterManifest?: AdapterManifest;
}

export interface LabServiceInfo {
  readonly name: string;
  readonly url: string;
}

export interface LabUpResult {
  readonly profile: string;
  readonly envFile: string;
  readonly services: readonly LabServiceInfo[];
}

export interface LabDemoOptions {
  readonly keep?: boolean;
  readonly seed?: string;
  readonly artifactPath?: string;
  readonly reportPath?: string;
}

export interface LabDemoResult {
  readonly status: ScenarioRunResult['status'];
  readonly result: ScenarioRunResult;
  readonly envFile: string;
  readonly artifactPath: string;
  readonly reportPath: string;
  readonly startedStack: boolean;
  readonly keptStack: boolean;
}

export interface LabRuntime {
  up(profile: string): Promise<LabUpResult | void>;
  down(profile: string): Promise<void>;
  demo(options: LabDemoOptions): Promise<LabDemoResult>;
  run(scenario: ScenarioSpec, seed: string, selection?: LabSelection): Promise<ScenarioRunResult>;
  replay(artifact: FailureArtifact): Promise<ScenarioRunResult>;
  shrink(artifact: FailureArtifact, runLimit?: number): Promise<ScenarioRunResult>;
  matrix(
    profile: string,
    seed: string,
    adapterManifest?: AdapterManifest,
    releaseSuite?: LoadedReleaseSuite,
  ): Promise<readonly MatrixCaseResult[]>;
  preview(
    profile: string,
    seed: string,
    adapterManifest: AdapterManifest,
    sender: string,
    receiver: string,
    scenarioSuite: LoadedReleaseSuite,
  ): Promise<MatrixCaseResult>;
}

export interface CliIo {
  readonly readText: (path: string) => Promise<string>;
  /** Read at most maxBytes without first buffering an arbitrarily large file. */
  readonly readTextLimited?: (path: string, maxBytes: number) => Promise<string>;
  readonly realPath: (path: string) => Promise<string>;
  readonly writeText: (path: string, value: string) => Promise<void>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface RunCliDependencies {
  readonly runtime?: LabRuntime;
  readonly lifecycleRuntime?: import('./commands/lifecycle.js').LifecycleLabRuntime;
  readonly io?: CliIo;
  readonly doctorProbes?: import('./doctor.js').DoctorProbes;
  readonly distribution?: 'workspace' | 'package';
  readonly version?: string;
  readonly adapterPreflight?: (
    manifest: AdapterManifest,
    options: {
      readonly profile: string;
      readonly adapterId?: string;
      readonly requiredRoles?: ReadonlyMap<string, readonly ('sender' | 'receiver')[]>;
    },
  ) => Promise<AdapterPreflightReport>;
  readonly adapterPreview?: (
    manifest: AdapterManifest,
    options: {
      readonly profile: string;
      readonly seed: string;
      readonly sender: string;
      readonly receiver: string;
      readonly manifestPath: string;
    },
  ) => Promise<{
    readonly status: MatrixCaseResult['status'];
    readonly artifacts: ReadonlyMap<string, string>;
  }>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CliOutcome {
  readonly exitCode: 0 | 1 | 2;
}

const defaultIo: CliIo = {
  readText: async (path) => readFile(path, 'utf8'),
  readTextLimited: async (path, maxBytes) => {
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      if (metadata.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },
  realPath: realpath,
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
  const packagedRelative = path.endsWith('.json') ? path : `${path}.json`;
  const candidates = [
    path,
    ...(!path.endsWith('.json') ? [`scenarios/${path}.json`] : []),
    runtimeAssetPath('scenarios', packagedRelative),
  ];
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
  try {
    return parseAdapterManifest(json(await io.readText(path)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Adapter manifest could not be read';
    throw new LabDiagnosticError(
      createDiagnostic('ADAPTER_MANIFEST_INVALID', {
        problem: `Adapter manifest is invalid: ${detail}`,
      }),
    );
  }
}

async function readReleasePolicy(
  io: CliIo,
  path: string | undefined,
  distribution: 'workspace' | 'package',
): Promise<ReleasePolicy | undefined> {
  if (path === undefined) return undefined;
  let contents: string;
  try {
    contents = await io.readText(path);
  } catch (error) {
    if (distribution !== 'package' || !path.startsWith('spec/')) throw error;
    contents = await io.readText(runtimeAssetPath(path));
  }
  return validateReleasePolicy(json(contents));
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
  const diagnosticJson = argv[2] === '--json';
  const parseArgv = diagnosticJson ? [argv[0]!, argv[1]!, ...argv.slice(3)] : [...argv];
  const io = dependencies.io ?? defaultIo;
  const env = dependencies.env ?? process.env;
  const runtime = dependencies.runtime ?? new PackagedLabRuntime({ env });
  const doctorProbes = dependencies.doctorProbes;
  const cliVersion = dependencies.version ?? '0.1.0';
  let exitCode: CliOutcome['exitCode'] = 0;
  const program = new Command()
    .name('cashu-fault-lab')
    .description('Deterministic Cashu payment delivery fault laboratory')
    .version(cliVersion)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  registerLifecycleCommands(program, {
    io,
    runtime,
    distribution: dependencies.distribution ?? 'workspace',
    lifecycleRuntime: dependencies.lifecycleRuntime ?? createEnvironmentLifecycleRuntime(env),
    ...(doctorProbes === undefined ? {} : { doctorProbes }),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  registerWalletDoctorCommands(program, {
    io,
    env,
    distribution: dependencies.distribution ?? 'workspace',
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const adapterPreflight =
    dependencies.adapterPreflight ??
    ((
      manifest: AdapterManifest,
      options: {
        readonly profile: string;
        readonly adapterId?: string;
        readonly requiredRoles?: ReadonlyMap<string, readonly ('sender' | 'receiver')[]>;
      },
    ) =>
      preflightLocalAdapters({
        manifest,
        env,
        profile: options.profile,
        ...(options.adapterId === undefined ? {} : { adapterId: options.adapterId }),
        ...(options.requiredRoles === undefined ? {} : { requiredRoles: options.requiredRoles }),
      }));
  registerAdapterCommands(program, {
    io,
    loadManifest: async (path) => {
      const manifest = await readAdapterManifest(io, path);
      if (manifest === undefined) throw new Error('Adapter manifest path is required');
      return manifest;
    },
    preflight: adapterPreflight,
    preview:
      dependencies.adapterPreview ??
      (async (manifest, options) => {
        const selectedIds = new Set([options.sender, options.receiver]);
        const registrations = manifest.adapters.filter(({ id }) => selectedIds.has(id));
        if (
          !registrations.some(({ id }) => id === options.sender) ||
          !registrations.some(({ id }) => id === options.receiver)
        ) {
          throw new LabDiagnosticError(
            createDiagnostic('ADAPTER_MANIFEST_INVALID', {
              problem: `Selected adapter pair is not registered: ${options.sender} -> ${options.receiver}`,
            }),
          );
        }
        const selectedManifest: AdapterManifest = {
          schemaVersion: manifest.schemaVersion,
          adapters: registrations,
        };
        const requiredRoles = new Map<string, Array<'sender' | 'receiver'>>();
        for (const [id, role] of [
          [options.sender, 'sender'],
          [options.receiver, 'receiver'],
        ] as const) {
          requiredRoles.set(id, [...new Set([...(requiredRoles.get(id) ?? []), role])]);
        }
        const preflight = await adapterPreflight(selectedManifest, {
          profile: options.profile,
          requiredRoles,
        });
        if (!preflight.ok) {
          const firstFailure = preflight.checks.find(({ status }) => status === 'failed');
          throw new LabDiagnosticError(
            createDiagnostic('ADAPTER_CONTRACT_INCOMPATIBLE', {
              problem:
                firstFailure === undefined
                  ? 'Selected adapter pair failed preflight.'
                  : `${firstFailure.code}: ${firstFailure.message}`,
              ...(firstFailure?.remediation === undefined
                ? {}
                : { remediation: firstFailure.remediation }),
              nextCommand: `cashu-fault-lab adapter preflight --adapters adapter-manifest.json --profile ${options.profile}`,
            }),
          );
        }
        const repositoryRoot = runtimeAssetPath();
        const scenarioSuite = await loadReleaseSuite({
          repositoryRoot,
          path: 'spec/maintainer-preview-suite.json',
          readText: io.readText,
          realPath: io.realPath,
        });
        if (scenarioSuite.profile !== options.profile) {
          throw new LabDiagnosticError(
            createDiagnostic('PROFILE_UNSUPPORTED', {
              problem: `Maintainer preview suite requires profile ${scenarioSuite.profile}.`,
            }),
          );
        }
        let previewRuntime = runtime;
        let ownedGateway: HttpFaultGateway | undefined;
        if (
          env.CFL_HTTP_FAULT_GATEWAY_URL === undefined &&
          env.CFL_HTTP_FAULT_GATEWAY_TOKEN === undefined
        ) {
          const receiver = registrations.find(({ id }) => id === options.receiver);
          if (receiver === undefined) throw new Error('Preview receiver registration is missing');
          const token = `cfl_preview_${randomBytes(24).toString('base64url')}`;
          ownedGateway = new HttpFaultGateway({
            downstream: receiver.url,
            controlToken: token,
          });
          let url: string;
          try {
            url = await ownedGateway.listen(4300, '127.0.0.1');
          } catch {
            await ownedGateway.close();
            throw new LabDiagnosticError(
              createDiagnostic('PORT_IN_USE', {
                problem: 'The automatic maintainer-preview gateway could not bind port 4300.',
                remediation:
                  'Stop the process using loopback port 4300, or configure an existing loopback gateway with CFL_HTTP_FAULT_GATEWAY_URL and CFL_HTTP_FAULT_GATEWAY_TOKEN.',
              }),
            );
          }
          if (dependencies.runtime === undefined) {
            previewRuntime = new PackagedLabRuntime({
              env: {
                ...env,
                CFL_HTTP_FAULT_GATEWAY_URL: url,
                CFL_HTTP_FAULT_GATEWAY_TOKEN: token,
              },
            });
          }
        } else {
          try {
            validateLocalFaultGateway(env);
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const code = message.startsWith('FAULT_GATEWAY_NOT_LOOPBACK')
              ? 'FAULT_GATEWAY_NOT_LOOPBACK'
              : 'FAULT_GATEWAY_REQUIRED';
            throw new LabDiagnosticError(createDiagnostic(code));
          }
        }
        let result: MatrixCaseResult;
        try {
          result = await previewRuntime.preview(
            options.profile,
            options.seed,
            selectedManifest,
            options.sender,
            options.receiver,
            scenarioSuite,
          );
        } finally {
          await ownedGateway?.close();
        }
        const resultScenarios = 'scenarios' in result ? (result.scenarios ?? []) : [];
        const scenarioEvidence = new Map(
          resultScenarios.map((scenario) => [scenario.id, scenario]),
        );
        const artifacts = createAdapterPreviewArtifacts({
          profile: options.profile,
          seed: options.seed,
          sender: options.sender,
          receiver: options.receiver,
          manifestPath: options.manifestPath,
          preflight,
          result,
          cliVersion,
          runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
          },
          scenarios: scenarioSuite.scenarios.map((scenario) => ({
            id: scenario.id,
            path: scenario.scenario,
            seed:
              scenarioEvidence.get(scenario.id)?.seed ??
              `${options.seed}:${options.sender}:${options.receiver}:${scenario.id}`,
          })),
        });
        return { status: result.status, artifacts };
      }),
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  program
    .command('demo')
    .description('Run the response-loss recovery demo against the reference stack')
    .option('--keep', 'leave a stack started by this command running', false)
    .option('--seed <seed>', 'deterministic demo seed', 'cashu-fault-lab-v0.1.0-demo')
    .option('--artifact <path>', 'write JSON evidence to this path')
    .option('--report <path>', 'write HTML report to this path')
    .action(
      async (options: { keep: boolean; seed: string; artifact?: string; report?: string }) => {
        const result = await runtime.demo({
          keep: options.keep,
          seed: options.seed,
          ...(options.artifact === undefined ? {} : { artifactPath: options.artifact }),
          ...(options.report === undefined ? {} : { reportPath: options.report }),
        });
        io.stdout(
          `demo ${result.status} seed=${result.result.artifact.seed} report=${result.reportPath}\n`,
        );
        if (result.result.status === 'failed') {
          io.stderr(`${result.result.error.name}: ${result.result.error.message}\n`);
          exitCode = 1;
        }
      },
    );

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
                  : cmd.type === 'arm_crash'
                    ? `arm_crash: ${cmd.component} ${cmd.boundary} occurrence=${cmd.occurrence ?? 1}`
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
        if (result.status === 'failed') {
          io.stderr(`${result.error.name}: ${result.error.message}\n`);
          exitCode = 1;
        }
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
    .option('--release-policy <path>', 'release policy JSON file')
    .option('--release-suite <path>', 'release scenario suite JSON file')
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
        releasePolicy?: string;
        releaseSuite?: string;
        adapters?: string;
        format: 'text' | 'json' | 'junit' | 'html';
        output?: string;
        verbose: boolean;
      }) => {
        const minimum = options.minPasses === undefined ? 0 : Number(options.minPasses);
        if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 10_000) {
          throw new Error('Minimum matrix passes must be a nonnegative safe integer');
        }
        const releasePolicy = await readReleasePolicy(
          io,
          options.releasePolicy,
          dependencies.distribution ?? 'workspace',
        );
        if (releasePolicy !== undefined && releasePolicy.profile !== options.profile) {
          throw new Error(
            `Release policy profile ${releasePolicy.profile} does not match matrix profile ${options.profile}`,
          );
        }
        verboseLine(options.verbose, io, `profile: ${options.profile}`);
        verboseLine(options.verbose, io, `seed: ${options.seed}`);
        const start = Date.now();
        const adapterManifest = await readAdapterManifest(io, options.adapters);
        const releaseSuitePath =
          options.releaseSuite ??
          (releasePolicy === undefined ? undefined : 'spec/release-suite.json');
        const usePackagedReleaseSuite =
          dependencies.distribution === 'package' &&
          options.releaseSuite === undefined &&
          releasePolicy !== undefined;
        const releaseSuite =
          releaseSuitePath === undefined
            ? undefined
            : await loadReleaseSuite({
                repositoryRoot: usePackagedReleaseSuite ? runtimeAssetPath() : process.cwd(),
                path: releaseSuitePath,
                readText: io.readText,
                realPath: io.realPath,
              });
        if (releaseSuite !== undefined && releaseSuite.profile !== options.profile) {
          throw new Error(
            `Release suite profile ${releaseSuite.profile} does not match matrix profile ${options.profile}`,
          );
        }
        if (
          releasePolicy !== undefined &&
          releaseSuite !== undefined &&
          releaseSuite.digest !== releasePolicy.releaseSuiteDigest
        ) {
          throw new Error(
            `Release suite digest ${releaseSuite.digest} does not match policy ${releasePolicy.releaseSuiteDigest}`,
          );
        }
        const results = await runtime.matrix(
          options.profile,
          options.seed,
          adapterManifest,
          releaseSuite,
        );
        const releaseGate =
          releasePolicy === undefined ? undefined : evaluateReleasePolicy(releasePolicy, results);

        if (options.verbose || options.format === 'text') {
          for (const result of results) {
            const icon = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '—';
            io.stdout(
              `  ${icon} ${result.sender} → ${result.receiver}: ${result.status}${result.status === 'failed' && result.reason ? ` (${result.reason})` : ''}\n`,
            );
            if (result.status === 'passed') {
              for (const scenarioEvidence of result.scenarios) {
                const scenarioIcon =
                  scenarioEvidence.status === 'passed'
                    ? '✓'
                    : scenarioEvidence.status === 'failed'
                      ? '✗'
                      : '—';
                io.stdout(
                  `      ${scenarioIcon} ${scenarioEvidence.id}: ${scenarioEvidence.status}${scenarioEvidence.reason === undefined ? '' : ` (${scenarioEvidence.reason})`}\n`,
                );
                for (const invariant of scenarioEvidence.invariants.filter(
                  ({ status }) => status !== 'passed',
                )) {
                  io.stdout(`          ${invariant.id}: ${invariant.status}\n`);
                }
              }
            }
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
          if (releaseGate !== undefined) {
            io.stdout(`release gate: ${releaseGate.passed ? 'passed' : 'failed'}\n`);
            for (const reason of releaseGate.reasons) {
              io.stderr(
                `release gate ${reason.code}${reason.pair === undefined ? '' : ` [${reason.pair}]`}: ${reason.message}\n`,
              );
            }
          }
        } else {
          const matrixInput = {
            profile: options.profile,
            seed: options.seed,
            results,
            ...(releaseGate === undefined ? {} : { releaseGate }),
          };
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
        if (releaseGate !== undefined && !releaseGate.passed) exitCode = 1;
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
      const roots = [...new Set(['scenarios', runtimeAssetPath('scenarios')])];
      const entries: { path: string; name: string; description?: string }[] = [];
      const seen = new Set<string>();

      for (const root of roots) {
        const walk = async (dir: string): Promise<void> => {
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
                  const scenarioPath = relative(root, full).replace(/\\/g, '/');
                  if (seen.has(scenarioPath)) continue;
                  seen.add(scenarioPath);
                  entries.push({
                    path: scenarioPath,
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
        try {
          await walk(root);
        } catch {
          // This distribution does not contain a scenarios directory.
        }
      }

      entries.sort((left, right) => left.path.localeCompare(right.path));

      if (options.json) {
        io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
      } else {
        if (entries.length === 0) {
          io.stdout('no scenarios found\n');
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

  try {
    await program.parseAsync(parseArgv, { from: 'node' });
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return { exitCode: 0 };
    }
    if (error instanceof LabDiagnosticError) {
      io.stderr(
        diagnosticJson
          ? renderDiagnosticJson(error.diagnostic)
          : renderDiagnosticText(error.diagnostic),
      );
    } else {
      io.stderr(`${safeError(error)}\n`);
    }
    return { exitCode: 2 };
  }
  return { exitCode };
}
