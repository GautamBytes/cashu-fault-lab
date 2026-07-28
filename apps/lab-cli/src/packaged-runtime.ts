import {
  currentAdapterContract,
  developmentIdentity,
  type AdapterCapabilities,
  type AdapterRoleCapability,
  type AdapterTransport,
  type AdapterTestControlClient,
  type CrashArmInput,
  type CrashArmStatus,
} from '@cashu-fault-lab/adapter-contract';
import { renderHtml, renderJson } from '@cashu-fault-lab/report';
import {
  CompatibilityMatrix,
  DirectExternalFaultController,
  ExternalAdapterScenarioDriver,
  HttpExternalFaultController,
  INVARIANT_REGISTRY,
  ScenarioRunner,
  minimizeFailingCommands,
  releaseSuiteFailure,
  seededProtocolId,
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
  type EvidenceConfidence,
  type ExternalFaultController,
  type InvariantEvidenceReference,
  type InvariantId,
  type InvariantResult,
  type InvariantStatus,
  type MatrixCaseResult,
  type MatrixExecutionResult,
  type MatrixParticipant,
  type MatrixScenarioEvidence,
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
import type { LoadedReleaseSuite, LoadedReleaseSuiteScenario } from './release-suite-loader.js';
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
  hasAny?(profile: string, options?: ServiceControlOptions): Promise<boolean>;
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

  async hasAny(profile: string, options: ServiceControlOptions = {}): Promise<boolean> {
    const base = this.#composeArgs(profile, options);
    try {
      const result = await this.#execute('docker', [...base, 'ps', '--services']);
      return (result?.stdout ?? '').trim().length > 0;
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
    version: '0.1.0',
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
  'adapter-contract': '0.1.0',
  'delivery-core': '0.1.0',
  'lab-cli': '0.1.0',
  oracle: '0.1.0',
  report: '0.1.0',
  'scenario-runner': '0.1.0',
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

function redactSecrets(value: string, env: Readonly<Record<string, string>>): string {
  let redacted = value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:cashu[AB]|nsec1)[A-Za-z0-9_-]+/gi, '[REDACTED]');
  for (const secret of secretValues(env)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function redactResultSecrets(
  result: ScenarioRunResult,
  env: Readonly<Record<string, string>>,
): ScenarioRunResult {
  if (result.status !== 'failed') return result;
  return {
    ...result,
    error: {
      name: redactSecrets(result.error.name, env),
      message: redactSecrets(result.error.message, env),
    },
  };
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

const DURABILITY_RANK = {
  process: 0,
  persistent: 1,
  restart_safe: 2,
} as const;

function logicalAliases(
  scenario: ScenarioSpec,
): { readonly senderAlias: string; readonly requestAlias: string } | undefined {
  const sends = scenario.commands.filter(
    (command) => command.type === 'send' || command.type === 'start_send',
  );
  const senderAliases = [...new Set(sends.map((command) => command.sender))];
  const requestAliases = [...new Set(sends.map((command) => command.requestId))];
  if (senderAliases.length !== 1 || requestAliases.length !== 1) return undefined;
  return { senderAlias: senderAliases[0]!, requestAlias: requestAliases[0]! };
}

function suiteNotApplicable(
  entry: LoadedReleaseSuiteScenario,
  seed: string,
  reason: string,
): MatrixScenarioEvidence {
  return {
    id: entry.id,
    seed,
    status: 'not_applicable',
    requiredInvariants: entry.requiredInvariants,
    invariants: [],
    reason,
  };
}

function suiteProvenance(
  result: ScenarioRunResult,
): Pick<MatrixScenarioEvidence, 'capabilities' | 'componentVersions' | 'imageDigests'> {
  return {
    capabilities: result.artifact.capabilities,
    componentVersions: result.artifact.componentVersions ?? {},
    imageDigests: result.artifact.imageDigests ?? {},
  };
}

function suiteEvidence(
  entry: LoadedReleaseSuiteScenario,
  seed: string,
  result: ScenarioRunResult,
): MatrixScenarioEvidence {
  const rejectedRequiredInvariant = entry.requiredInvariants.find((required) => {
    const invariant = result.artifact.invariants.find((item) => item.id === required);
    return invariant === undefined || invariant.status !== 'passed';
  });
  if (result.status === 'passed' && rejectedRequiredInvariant === undefined) {
    return {
      id: entry.id,
      seed,
      status: 'passed',
      requiredInvariants: entry.requiredInvariants,
      invariants: result.artifact.invariants,
      ...suiteProvenance(result),
    };
  }
  if (result.status === 'failed' && result.error.name === 'AdapterNotApplicableError') {
    return suiteNotApplicable(
      entry,
      seed,
      'Selected adapters do not implement this release scenario',
    );
  }
  return {
    id: entry.id,
    seed,
    status: 'failed',
    requiredInvariants: entry.requiredInvariants,
    invariants: result.artifact.invariants,
    ...suiteProvenance(result),
    code:
      rejectedRequiredInvariant === undefined
        ? 'SCENARIO_EXECUTION_FAILED'
        : 'REQUIRED_INVARIANT_NOT_ACCEPTED',
    reason:
      rejectedRequiredInvariant === undefined
        ? 'Release scenario execution failed'
        : `Required invariant was not accepted: ${rejectedRequiredInvariant}`,
  };
}

const INVARIANT_STATUS_RANK: Readonly<Record<InvariantStatus, number>> = {
  passed: 0,
  not_applicable: 1,
  not_observable: 2,
  failed: 3,
};

const EVIDENCE_CONFIDENCE_RANK: Readonly<Record<EvidenceConfidence, number>> = {
  observed: 0,
  derived: 1,
  adapter_claimed: 2,
};

function evidenceKey(reference: InvariantEvidenceReference): string {
  return JSON.stringify([
    reference.source,
    reference.index ?? null,
    reference.field ?? null,
    reference.description,
  ]);
}

export function aggregateReleaseSuiteInvariants(
  scenarios: readonly MatrixScenarioEvidence[],
): readonly InvariantResult[] {
  const occurrences = new Map<
    InvariantId,
    Array<{ readonly scenario: string; readonly result: InvariantResult }>
  >();
  for (const scenario of scenarios) {
    const byId = new Map(scenario.invariants.map((invariant) => [invariant.id, invariant]));
    for (const id of scenario.requiredInvariants) {
      const result =
        byId.get(id) ??
        ({
          id,
          status: 'not_observable',
          confidence: 'derived',
          evidence: [],
          reason: `Required invariant evidence is missing from scenario ${scenario.id}.`,
        } satisfies InvariantResult);
      occurrences.set(id, [...(occurrences.get(id) ?? []), { scenario: scenario.id, result }]);
    }
  }

  return INVARIANT_REGISTRY.flatMap(({ id }) => {
    const selected = occurrences.get(id);
    if (selected === undefined || selected.length === 0) return [];
    const status = selected.reduce<InvariantStatus>(
      (weakest, occurrence) =>
        INVARIANT_STATUS_RANK[occurrence.result.status] > INVARIANT_STATUS_RANK[weakest]
          ? occurrence.result.status
          : weakest,
      'passed',
    );
    const confidence = selected.reduce<EvidenceConfidence>(
      (weakest, occurrence) =>
        EVIDENCE_CONFIDENCE_RANK[occurrence.result.confidence] > EVIDENCE_CONFIDENCE_RANK[weakest]
          ? occurrence.result.confidence
          : weakest,
      'observed',
    );
    const evidence = [
      ...new Map(
        selected
          .flatMap(({ result }) => result.evidence)
          .map((reference) => [evidenceKey(reference), reference]),
      ).values(),
    ].sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
    const reasons = selected
      .filter(({ result }) => result.status !== 'passed')
      .map(
        ({ scenario, result }) =>
          `${scenario}: ${result.reason ?? `invariant status is ${result.status}`}`,
      );
    return [
      {
        id,
        status,
        confidence,
        evidence,
        ...(reasons.length === 0 ? {} : { reason: reasons.join(' | ') }),
      },
    ];
  });
}

class RestartableExternalFaultController implements ExternalFaultController {
  readonly #base: ExternalFaultController;
  readonly #services: LabServiceController;
  readonly #components: Readonly<Record<string, string>>;
  readonly #controls: Readonly<Record<'sender' | 'receiver', AdapterTestControlClient>>;

  constructor(
    base: ExternalFaultController,
    services: LabServiceController,
    components: Readonly<Record<string, string>>,
    controls: Readonly<Record<'sender' | 'receiver', AdapterTestControlClient>>,
  ) {
    this.#base = base;
    this.#services = services;
    this.#components = components;
    this.#controls = controls;
  }

  async reset(): Promise<void> {
    await this.#base.reset();
  }

  configure(
    target: string,
    rule: Parameters<ExternalFaultController['configure']>[1],
    route?: Parameters<ExternalFaultController['configure']>[2],
  ): ReturnType<ExternalFaultController['configure']> {
    return this.#base.configure(target, rule, route);
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

  armCrash(input: CrashArmInput): Promise<void> {
    return this.#controls[input.component].armCrash(input);
  }

  crashStatus(): Promise<readonly CrashArmStatus[]> {
    return Promise.allSettled([
      this.#controls.sender.crashStatus(),
      this.#controls.receiver.crashStatus(),
    ]).then((results) => {
      const unique = new Map<string, CrashArmStatus>();
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const item of result.value) {
          unique.set(`${item.runId}:${item.component}:${item.boundary}:${item.occurrence}`, item);
        }
      }
      return [...unique.values()];
    });
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
    const seed = options.seed ?? 'cashu-fault-lab-v0.1.0-demo';
    const runtimeEnv = await this.#referenceEnv();
    const alreadyRunning = this.#services.isUp
      ? await this.#services.isUp('lab', { envFile: runtimeEnv.path })
      : false;
    const hadPreexistingStack = this.#services.hasAny
      ? await this.#services.hasAny('lab', { envFile: runtimeEnv.path })
      : alreadyRunning;
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
      result = redactResultSecrets(
        await this.run(spec, seed, {
          sender: 'cashu-ts',
          receiver: 'reference-receiver',
          adapterManifest: manifest,
        }),
        runtimeEnv.env,
      );
      const evidence = renderJson({ result });
      const report = renderHtml({ result });
      assertNoSecretLeak(evidence, runtimeEnv.env);
      assertNoSecretLeak(report, runtimeEnv.env);
      await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
      await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
      await writeFile(artifactPath, evidence, { encoding: 'utf8', mode: 0o600 });
      await writeFile(reportPath, report, { encoding: 'utf8', mode: 0o600 });
    } finally {
      if (startedStack && !hadPreexistingStack && options.keep !== true) {
        await this.#services.down('lab', { envFile: runtimeEnv.path });
      }
    }

    return {
      status: result.status,
      result,
      envFile: runtimeEnv.path,
      artifactPath,
      reportPath,
      startedStack,
      keptStack: alreadyRunning || hadPreexistingStack || options.keep === true,
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
      const aliases = logicalAliases(scenario);
      if (aliases === undefined) {
        return failedScenario(
          scenario,
          seed,
          'External scenarios require one logical sender and one logical request',
        );
      }
      const driver = new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new RestartableExternalFaultController(
          this.#faultController(),
          this.#services,
          {
            sender: selection.sender,
            receiver: selection.receiver,
          },
          { sender, receiver },
        ),
        amount: 8,
        unit: 'sat',
        transports: externalScenarioTransports(scenario.name),
        senderAlias: aliases.senderAlias,
        requestAlias: aliases.requestAlias,
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
    releaseSuite?: LoadedReleaseSuite,
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
        const smoke = await runExternalDeliveryPair({
          profile: selected,
          seed,
          sender: senderClient,
          receiver: receiverClient,
          amount: 8,
          unit: 'sat',
        });
        if (!smoke.ok || releaseSuite === undefined) return smoke;
        const scenarios: MatrixScenarioEvidence[] = [];
        for (const entry of releaseSuite.scenarios) {
          const scenarioSeed = String(
            seededProtocolId(seed, `release-suite:${sender.id}:${receiver.id}:${entry.id}`),
          );
          const senderRole = sender.capabilities.roles.sender;
          const receiverRole = receiver.capabilities.roles.receiver;
          if (
            senderRole === undefined ||
            DURABILITY_RANK[senderRole.durability] < DURABILITY_RANK[entry.senderDurability]
          ) {
            scenarios.push(
              suiteNotApplicable(
                entry,
                scenarioSeed,
                `Sender durability does not meet ${entry.senderDurability}`,
              ),
            );
            continue;
          }
          if (
            receiverRole === undefined ||
            DURABILITY_RANK[receiverRole.durability] < DURABILITY_RANK[entry.receiverDurability]
          ) {
            scenarios.push(
              suiteNotApplicable(
                entry,
                scenarioSeed,
                `Receiver durability does not meet ${entry.receiverDurability}`,
              ),
            );
            continue;
          }
          const aliases = logicalAliases(entry.spec);
          if (aliases === undefined) {
            scenarios.push({
              id: entry.id,
              seed: scenarioSeed,
              status: 'failed',
              requiredInvariants: entry.requiredInvariants,
              invariants: [],
              code: 'SCENARIO_INPUT_INVALID',
              reason: 'Release scenario requires one logical sender and request',
            });
            continue;
          }
          const evidence = registry.evidence(receiver.id);
          const driver = new ExternalAdapterScenarioDriver({
            sender: senderClient,
            receiver: receiverClient,
            ...(evidence === undefined ? {} : { evidence }),
            faults: new RestartableExternalFaultController(
              this.#faultController(),
              this.#services,
              { sender: sender.id, receiver: receiver.id },
              { sender: senderClient, receiver: receiverClient },
            ),
            amount: 8,
            unit: 'sat',
            transports: entry.transports,
            senderAlias: aliases.senderAlias,
            requestAlias: aliases.requestAlias,
          });
          const result = withPackagedMetadata(
            await new ScenarioRunner(driver).run(entry.spec, scenarioSeed),
          );
          scenarios.push(suiteEvidence(entry, scenarioSeed, result));
        }
        return {
          ...smoke,
          invariants: aggregateReleaseSuiteInvariants(scenarios),
          scenarios,
          releaseSuiteDigest: releaseSuite.digest,
        } satisfies MatrixExecutionResult;
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
    const results = await matrix.run(profileName, participants, participants);
    if (releaseSuite === undefined) return results;
    return results.map((result) => {
      if (result.status !== 'passed') return result;
      const scenarios = releaseSuite.scenarios.map((entry) =>
        suiteNotApplicable(
          entry,
          String(
            seededProtocolId(seed, `release-suite:${result.sender}:${result.receiver}:${entry.id}`),
          ),
          'Release suites require configured external adapters',
        ),
      );
      const invariants = aggregateReleaseSuiteInvariants(scenarios);
      const suiteFailure = releaseSuiteFailure(scenarios);
      if (suiteFailure !== undefined) {
        return {
          ...result,
          status: 'failed',
          ...suiteFailure,
          invariants,
          releaseSuiteDigest: releaseSuite.digest,
          scenarios,
        };
      }
      return {
        ...result,
        invariants,
        releaseSuiteDigest: releaseSuite.digest,
        scenarios,
      };
    });
  }
}
