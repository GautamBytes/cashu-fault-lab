import {
  currentAdapterContract,
  developmentIdentity,
  type AdapterCapabilities,
  type AdapterRoleCapability,
  type AdapterTransport,
} from '@cashu-fault-lab/adapter-contract';
import { renderHtml, renderJson } from '@cashu-fault-lab/report';
import {
  CompatibilityMatrix,
  DirectExternalFaultController,
  ExternalAdapterScenarioDriver,
  HttpExternalFaultController,
  ScenarioRunner,
  minimizeFailingCommands,
  runExternalDeliveryPair,
  runReferenceDeliveryProbe,
  runReferenceHttpScenario,
  runReferenceNostrScenario,
  runReferenceCrashScenario,
  runReferenceSecurityScenario,
  runReferenceExpiryScenario,
  runReferenceConflictScenario,
  runReferenceNut19Scenario,
  unobservableInvariantResults,
  type FailureArtifact,
  type ExternalFaultController,
  type MatrixCaseResult,
  type MatrixParticipant,
  type ScenarioError,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  LabDemoOptions,
  LabDemoResult,
  LabRuntime,
  LabSelection,
  LabUpResult,
} from './index.js';
import { ExternalAdapterRegistry } from './adapter-registry.js';
import type { AdapterManifest } from './adapter-manifest.js';
import { ensureReferenceRuntimeEnv } from './runtime-env.js';

const execFileAsync = promisify(execFile);

type CommandExecutor = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string } | void>;

const executeCommand: CommandExecutor = async (file, args) => {
  return await execFileAsync(file, [...args]);
};

export interface ServiceControlOptions {
  readonly envFile?: string;
}

export interface LabServiceController {
  up(profile: string, options?: ServiceControlOptions): Promise<void>;
  down(profile: string, options?: ServiceControlOptions): Promise<void>;
  isUp?(profile: string, options?: ServiceControlOptions): Promise<boolean>;
  restart?(service: string): Promise<void>;
}

export interface PackagedLabRuntimeOptions {
  readonly services?: LabServiceController;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly externalFaults?: ExternalFaultController;
  readonly runtimeRoot?: string;
}

export class DockerComposeServiceController implements LabServiceController {
  readonly #execute: CommandExecutor;

  constructor(execute: CommandExecutor = executeCommand) {
    this.#execute = execute;
  }

  #composeArgs(profile: string, options: ServiceControlOptions = {}): readonly string[] {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
      throw new Error('Compose profile is invalid');
    }
    if (profile === 'lab') {
      if (options.envFile === undefined) {
        throw new Error('Reference lab compose requires an env file');
      }
      const composeFile = fileURLToPath(
        new URL('../../../infra/compose/wallet-adapters.compose.yml', import.meta.url),
      );
      return ['compose', '--env-file', options.envFile, '-f', composeFile];
    }
    const composeFile = fileURLToPath(
      new URL('../../../infra/compose/lab.compose.yml', import.meta.url),
    );
    return ['compose', '-f', composeFile, '--profile', profile];
  }

  async up(profile: string, options: ServiceControlOptions = {}): Promise<void> {
    const base = this.#composeArgs(profile, options);
    await this.#execute('docker', [
      ...base,
      'up',
      ...(profile === 'lab' ? ['--build'] : []),
      '-d',
      ...(profile === 'lab' ? ['--wait'] : []),
    ]);
  }

  async down(profile: string, options: ServiceControlOptions = {}): Promise<void> {
    const base = this.#composeArgs(profile, options);
    await this.#execute('docker', [...base, 'down', '-v']);
  }

  async isUp(profile: string, options: ServiceControlOptions = {}): Promise<boolean> {
    const base = this.#composeArgs(profile, options);
    try {
      const result = await this.#execute('docker', [
        ...base,
        'ps',
        '--services',
        '--filter',
        'status=running',
      ]);
      const stdout = result?.stdout ?? '';
      return profile === 'lab'
        ? ['cashu-ts', 'cdk', 'reference-receiver'].every((service) =>
            stdout.split(/\s+/u).includes(service),
          )
        : stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async restart(service: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(service)) {
      throw new Error('Compose service is invalid');
    }
    const composeFile = fileURLToPath(
      new URL('../../../infra/compose/wallet-adapters.compose.yml', import.meta.url),
    );
    await this.#execute('docker', ['compose', '-f', composeFile, 'restart', service]);
  }
}

function role(profiles: readonly string[]): AdapterRoleCapability {
  return {
    transports: ['http', 'nostr'],
    profiles,
    durability: 'process',
    evidence: { tier: 'T0', sources: ['adapter'] },
  };
}

const referenceCapabilities: AdapterCapabilities = {
  schemaVersion: 2,
  contract: currentAdapterContract(),
  implementation: developmentIdentity({
    id: 'reference-ts',
    version: '0.0.0',
    language: 'typescript',
    runtime: 'node-24',
  }),
  roles: {
    sender: role(['legacy-nut18', 'delivery-v1']),
    receiver: role(['legacy-nut18', 'delivery-v1']),
  },
  nuts: [2, 3, 7, 9, 10, 12, 18, 19],
  encodings: ['creqA'],
  mints: [],
};

function upstreamCapabilities(
  implementation: 'cashu-ts' | 'cdk',
  version: string,
): AdapterCapabilities {
  return {
    schemaVersion: 2,
    contract: currentAdapterContract(),
    implementation: developmentIdentity({
      id: implementation,
      version,
      language: implementation === 'cdk' ? 'rust' : 'typescript',
      runtime: implementation === 'cdk' ? 'native' : 'node-24',
    }),
    roles: {
      sender: role(['legacy-nut18', 'nut26-nostr']),
      receiver: role(['legacy-nut18', 'nut26-nostr']),
    },
    nuts: [18, 26],
    encodings: ['creqA', 'creqB'],
    mints: [],
  };
}

const participants: readonly MatrixParticipant[] = [
  { id: 'reference-ts', capabilities: referenceCapabilities },
  { id: 'cashu-ts', capabilities: upstreamCapabilities('cashu-ts', '4.7.2') },
  { id: 'cdk', capabilities: upstreamCapabilities('cdk', '0.17.3') },
];

const packagedComponentVersions: Readonly<Record<string, string>> = {
  'adapter-contract': '0.0.0',
  'delivery-core': '0.0.0',
  'lab-cli': '0.0.0',
  oracle: '0.0.0',
  report: '0.0.0',
  'scenario-runner': '0.0.0',
};

const referenceServices = [
  { name: 'Nutshell mint', url: 'http://127.0.0.1:3338' },
  { name: 'cashu-ts adapter', url: 'http://127.0.0.1:4101' },
  { name: 'CDK adapter', url: 'http://127.0.0.1:4102' },
  { name: 'Reference receiver', url: 'http://127.0.0.1:4200' },
  { name: 'HTTP fault gateway', url: 'http://127.0.0.1:4300' },
  { name: 'Nostr fault relay', url: 'ws://127.0.0.1:4400' },
] as const;

function withPackagedMetadata(result: ScenarioRunResult): ScenarioRunResult {
  const artifact = {
    ...result.artifact,
    componentVersions: {
      ...packagedComponentVersions,
      ...(result.artifact.componentVersions ?? {}),
    },
    imageDigests: result.artifact.imageDigests ?? {},
  };
  return result.status === 'failed' ? { ...result, artifact } : { ...result, artifact };
}

function failedScenario(scenario: ScenarioSpec, seed: string, message: string): ScenarioRunResult {
  return withPackagedMetadata({
    status: 'failed',
    error: { name: 'Error', message },
    artifact: {
      schemaVersion: 2,
      seed,
      scenario: scenario.name,
      commands: scenario.commands,
      history: [],
      capabilities: {},
      invariants: unobservableInvariantResults(
        'Scenario setup failed before invariant evidence could be collected.',
      ),
    },
  });
}

function secretValues(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env)
    .filter(([name, value]) => /TOKEN|KEY|PASSWORD/u.test(name) && value.length >= 8)
    .flatMap(([name, value]) =>
      name.endsWith('STATE_KEYS')
        ? value.split(',').map((entry) => entry.split(':').at(-1) ?? '')
        : [value],
    )
    .filter((value) => value.length >= 8);
}

function assertNoSecretLeak(contents: string, env: Readonly<Record<string, string>>): void {
  for (const secret of secretValues(env)) {
    if (contents.includes(secret)) {
      throw new Error('Generated runtime secret leaked into demo output');
    }
  }
}

function externalScenarioTransports(scenarioName: string): readonly AdapterTransport[] {
  if (scenarioName === 'nostr-response-lost') return ['nostr'];
  if (
    scenarioName === 'http-nostr-fallback' ||
    scenarioName === 'cross-transport-duplicate-storm'
  ) {
    return ['http', 'nostr'];
  }
  return ['http'];
}

class RestartableExternalFaultController implements ExternalFaultController {
  readonly #base: ExternalFaultController;
  readonly #services: LabServiceController;
  readonly #components: Readonly<Record<string, string>>;

  constructor(
    base: ExternalFaultController,
    services: LabServiceController,
    components: Readonly<Record<string, string>>,
  ) {
    this.#base = base;
    this.#services = services;
    this.#components = components;
  }

  async reset(): Promise<void> {
    await this.#base.reset();
  }

  async configure(target: string, rule: Parameters<ExternalFaultController['configure']>[1]) {
    await this.#base.configure(target, rule);
  }

  async clear(target?: string): Promise<void> {
    await this.#base.clear(target);
  }

  async evidence(): Promise<Awaited<ReturnType<ExternalFaultController['evidence']>>> {
    return this.#base.evidence();
  }

  async restart(component: string): Promise<void> {
    const service = this.#components[component];
    if (service === undefined) {
      if (this.#base.restart !== undefined) {
        await this.#base.restart(component);
        return;
      }
      throw new Error(`External restart component is not configured: ${component}`);
    }
    if (this.#services.restart === undefined) {
      throw new Error('External service restart is not configured');
    }
    await this.#services.restart(service);
  }
}

export class PackagedLabRuntime implements LabRuntime {
  readonly #services: LabServiceController;
  #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof fetch | undefined;
  readonly #externalFaults: ExternalFaultController | undefined;
  readonly #runtimeRoot: string;

  constructor(options: PackagedLabRuntimeOptions = {}) {
    this.#services = options.services ?? new DockerComposeServiceController();
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
    this.#runtimeRoot = options.runtimeRoot ?? process.cwd();
    const faultUrl = this.#env.CFL_HTTP_FAULT_GATEWAY_URL;
    const faultToken = this.#env.CFL_HTTP_FAULT_GATEWAY_TOKEN;
    if (faultUrl !== undefined && faultToken === undefined) {
      throw new Error(
        'CFL_HTTP_FAULT_GATEWAY_TOKEN is required when CFL_HTTP_FAULT_GATEWAY_URL is set',
      );
    }
    this.#externalFaults = options.externalFaults;
  }

  #faultController(): ExternalFaultController {
    if (this.#externalFaults !== undefined) return this.#externalFaults;
    const faultUrl = this.#env.CFL_HTTP_FAULT_GATEWAY_URL;
    const faultToken = this.#env.CFL_HTTP_FAULT_GATEWAY_TOKEN;
    return faultUrl !== undefined && faultToken !== undefined
      ? new HttpExternalFaultController({
          baseUrl: faultUrl,
          token: faultToken,
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        })
      : new DirectExternalFaultController();
  }

  async #referenceEnv() {
    const runtimeEnv = await ensureReferenceRuntimeEnv(this.#runtimeRoot);
    this.#env = { ...this.#env, ...runtimeEnv.env };
    return runtimeEnv;
  }

  async up(profile: string): Promise<LabUpResult> {
    if (profile !== 'lab') {
      await this.#services.up(profile);
      return { profile, envFile: '', services: [] };
    }
    const runtimeEnv = await this.#referenceEnv();
    const alreadyRunning = this.#services.isUp
      ? await this.#services.isUp(profile, { envFile: runtimeEnv.path })
      : false;
    if (!alreadyRunning) await this.#services.up(profile, { envFile: runtimeEnv.path });
    return { profile, envFile: runtimeEnv.path, services: referenceServices };
  }

  async down(profile: string): Promise<void> {
    if (profile !== 'lab') {
      await this.#services.down(profile);
      return;
    }
    const runtimeEnv = await this.#referenceEnv();
    await this.#services.down(profile, { envFile: runtimeEnv.path });
  }

  async demo(options: LabDemoOptions = {}): Promise<LabDemoResult> {
    const seed = options.seed ?? 'cashu-fault-lab-demo';
    const runtimeEnv = await this.#referenceEnv();
    const alreadyRunning = this.#services.isUp
      ? await this.#services.isUp('lab', { envFile: runtimeEnv.path })
      : false;
    let startedStack = false;
    if (!alreadyRunning) {
      await this.#services.up('lab', { envFile: runtimeEnv.path });
      startedStack = true;
    }

    const reportsDirectory = join(
      this.#runtimeRoot,
      '.cashu-fault-lab',
      'runtime',
      'reference',
      'reports',
    );
    const artifactPath = options.artifactPath ?? join(reportsDirectory, 'demo.json');
    const reportPath = options.reportPath ?? join(reportsDirectory, 'demo.html');
    let result!: ScenarioRunResult;
    try {
      const scenarioPath = fileURLToPath(
        new URL('../../../scenarios/retry/response-lost.json', import.meta.url),
      );
      const spec = JSON.parse(await readFile(scenarioPath, 'utf8')) as ScenarioSpec;
      const manifest: AdapterManifest = {
        schemaVersion: 1,
        adapters: [
          { id: 'cashu-ts', url: 'http://127.0.0.1:4101', tokenEnv: 'CFL_CASHU_TS_TOKEN' },
          {
            id: 'reference-receiver',
            url: 'http://127.0.0.1:4200',
            tokenEnv: 'CFL_REFERENCE_RECEIVER_TOKEN',
          },
        ],
      };
      result = await this.run(spec, seed, {
        sender: 'cashu-ts',
        receiver: 'reference-receiver',
        adapterManifest: manifest,
      });
      const evidence = renderJson({ result });
      const report = renderHtml({ result });
      assertNoSecretLeak(evidence, runtimeEnv.env);
      assertNoSecretLeak(report, runtimeEnv.env);
      await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
      await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
      await writeFile(artifactPath, evidence, { encoding: 'utf8', mode: 0o600 });
      await writeFile(reportPath, report, { encoding: 'utf8', mode: 0o600 });
    } finally {
      if (startedStack && options.keep !== true) {
        await this.#services.down('lab', { envFile: runtimeEnv.path });
      }
    }

    return {
      status: result.status,
      result,
      artifactPath,
      reportPath,
      startedStack,
      keptStack: alreadyRunning || options.keep === true,
      generatedEnv: runtimeEnv.env,
    };
  }

  async run(
    scenario: ScenarioSpec,
    seed: string,
    selection: LabSelection = { sender: 'reference-ts', receiver: 'reference-ts' },
  ): Promise<ScenarioRunResult> {
    if (selection.adapterManifest !== undefined) {
      let registry: ExternalAdapterRegistry;
      try {
        registry = await ExternalAdapterRegistry.load(selection.adapterManifest, this.#env, {
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        });
      } catch {
        return failedScenario(scenario, seed, 'External adapter discovery failed');
      }
      const sender = registry.client(selection.sender);
      const receiver = registry.client(selection.receiver);
      if (sender === undefined || receiver === undefined) {
        return failedScenario(
          scenario,
          seed,
          `External adapter pair is not registered: ${selection.sender} -> ${selection.receiver}`,
        );
      }
      const sends = scenario.commands.filter((command) => command.type === 'send');
      const senderAliases = [...new Set(sends.map((command) => command.sender))];
      const requestAliases = [...new Set(sends.map((command) => command.requestId))];
      if (senderAliases.length !== 1 || requestAliases.length !== 1) {
        return failedScenario(
          scenario,
          seed,
          'External scenarios require one logical sender and one logical request',
        );
      }
      const driver = new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new RestartableExternalFaultController(this.#faultController(), this.#services, {
          sender: selection.sender,
          receiver: selection.receiver,
        }),
        amount: 8,
        unit: 'sat',
        transports: externalScenarioTransports(scenario.name),
        senderAlias: senderAliases[0]!,
        requestAlias: requestAliases[0]!,
      });
      return withPackagedMetadata(await new ScenarioRunner(driver).run(scenario, seed));
    }

    if (selection.sender !== 'reference-ts' || selection.receiver !== 'reference-ts') {
      return failedScenario(
        scenario,
        seed,
        `Unsupported adapter pair: ${selection.sender} -> ${selection.receiver}`,
      );
    }
    if (
      scenario.name === 'http-response-lost' ||
      scenario.name === 'http-request-lost' ||
      scenario.name === 'http-duplicate-storm'
    ) {
      return withPackagedMetadata(await runReferenceHttpScenario(scenario, seed));
    }
    if (scenario.name === 'nostr-response-lost') {
      return withPackagedMetadata(await runReferenceNostrScenario(scenario, seed, 'nostr'));
    }
    if (
      scenario.name === 'http-nostr-fallback' ||
      scenario.name === 'cross-transport-duplicate-storm'
    ) {
      return withPackagedMetadata(await runReferenceNostrScenario(scenario, seed, 'cross'));
    }
    if (
      scenario.name === 'crash-recovery-mint-response-lost' ||
      scenario.name === 'crash-recovery-receiver-restart-mid-swap' ||
      scenario.name === 'crash-recovery-sender-restart-mid-delivery'
    ) {
      return withPackagedMetadata(await runReferenceCrashScenario(scenario, seed));
    }
    if (scenario.name === 'expiry-created-expired') {
      return withPackagedMetadata(await runReferenceExpiryScenario(scenario, seed));
    }
    if (scenario.name.startsWith('conflict-')) {
      return withPackagedMetadata(await runReferenceConflictScenario(scenario, seed));
    }
    if (scenario.name === 'nut19-cache-hit-recovery') {
      return withPackagedMetadata(await runReferenceNut19Scenario(scenario, seed));
    }
    if (scenario.name.startsWith('security-')) {
      return withPackagedMetadata(await runReferenceSecurityScenario(scenario, seed));
    }
    return failedScenario(scenario, seed, `Unsupported packaged scenario: ${scenario.name}`);
  }

  async replay(artifact: FailureArtifact): Promise<ScenarioRunResult> {
    return this.run({ name: artifact.scenario, commands: artifact.commands }, artifact.seed);
  }

  async shrink(artifact: FailureArtifact, runLimit = 100): Promise<ScenarioRunResult> {
    const baseline = await this.replay(artifact);
    if (baseline.status !== 'failed') {
      throw new Error('Artifact does not reproduce a failure and cannot be minimized');
    }
    const sameFailure = (left: ScenarioError, right: ScenarioRunResult): boolean =>
      right.status === 'failed' &&
      right.error.name === left.name &&
      right.error.message === left.message;
    const commands = await minimizeFailingCommands(
      artifact.commands,
      async (candidate) => {
        const result = await this.run(
          { name: artifact.scenario, commands: candidate },
          artifact.seed,
        );
        return sameFailure(baseline.error, result);
      },
      runLimit,
    );
    const result = await this.run({ name: artifact.scenario, commands }, artifact.seed);
    if (!sameFailure(baseline.error, result)) {
      throw new Error('Minimized trace did not preserve the original failure');
    }
    return result;
  }

  async matrix(
    profileName: string,
    seed: string,
    adapterManifest?: AdapterManifest,
  ): Promise<readonly MatrixCaseResult[]> {
    if (adapterManifest !== undefined) {
      const registry = await ExternalAdapterRegistry.load(adapterManifest, this.#env, {
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      });
      const externalMatrix = new CompatibilityMatrix(async (selected, sender, receiver) => {
        const senderClient = registry.client(sender.id);
        const receiverClient = registry.client(receiver.id);
        if (senderClient === undefined || receiverClient === undefined) {
          return {
            ok: false,
            code: 'ADAPTER_REGISTRY_IDENTITY',
            reason: 'Matrix participant is missing from the external adapter registry',
          };
        }
        return runExternalDeliveryPair({
          profile: selected,
          seed,
          sender: senderClient,
          receiver: receiverClient,
          amount: 8,
          unit: 'sat',
        });
      });
      const externalParticipants = registry.participants();
      return externalMatrix.run(profileName, externalParticipants, externalParticipants);
    }

    const matrix = new CompatibilityMatrix(async (selected, sender, receiver) => {
      if (selected === 'delivery-v1') {
        if (sender.id !== 'reference-ts' || receiver.id !== 'reference-ts') {
          return {
            ok: null,
            reason: `${sender.id} -> ${receiver.id}: no executable delivery-v1 adapter pair is configured`,
          };
        }
        return runReferenceDeliveryProbe(seed);
      }
      if (selected === 'legacy-nut18') {
        return {
          ok: null,
          reason: `${sender.id} -> ${receiver.id}: codec evidence exists only in adapter contract tests; no executable pair is configured`,
        };
      }
      if (selected === 'nut26-nostr') {
        return {
          ok: false,
          code: 'NUT26_NIP_MAPPING_MISMATCH',
          reason: 'NUT-26 NIP-04/raw-key transport cannot be treated as NUT-18 NIP-17/nprofile',
        };
      }
      return { ok: false, code: 'UNKNOWN_PROFILE', reason: 'Matrix profile is not implemented' };
    });
    return matrix.run(profileName, participants, participants);
  }
}
