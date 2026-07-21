import type { AdapterCapabilities } from '@cashu-fault-lab/adapter-contract';
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
  type FailureArtifact,
  type ExternalFaultController,
  type MatrixCaseResult,
  type MatrixParticipant,
  type ScenarioError,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LabRuntime, LabSelection } from './index.js';
import { ExternalAdapterRegistry } from './adapter-registry.js';
import type { AdapterManifest } from './adapter-manifest.js';

const execFileAsync = promisify(execFile);

export interface LabServiceController {
  up(profile: string): Promise<void>;
  down(profile: string): Promise<void>;
}

export interface PackagedLabRuntimeOptions {
  readonly services?: LabServiceController;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly externalFaults?: ExternalFaultController;
}

class DockerComposeServiceController implements LabServiceController {
  async up(profile: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
      throw new Error('Compose profile is invalid');
    }
    const composeFile = fileURLToPath(
      new URL('../../../infra/compose/lab.compose.yml', import.meta.url),
    );
    await execFileAsync('docker', ['compose', '-f', composeFile, '--profile', profile, 'up', '-d']);
  }

  async down(profile: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
      throw new Error('Compose profile is invalid');
    }
    const composeFile = fileURLToPath(
      new URL('../../../infra/compose/lab.compose.yml', import.meta.url),
    );
    await execFileAsync('docker', [
      'compose',
      '-f',
      composeFile,
      '--profile',
      profile,
      'down',
      '-v',
    ]);
  }
}

function profile(
  name: string,
  status: 'supported' | 'unsupported',
  reason?: string,
): NonNullable<AdapterCapabilities['profiles']>[number] {
  return {
    name,
    roles: ['sender', 'receiver'],
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

const referenceCapabilities: AdapterCapabilities = {
  implementation: 'reference-ts',
  version: '0.0.0',
  nuts: [2, 3, 7, 9, 10, 12, 18, 19],
  transports: ['http', 'nostr'],
  evidenceTier: 'T0',
  encodings: ['creqA'],
  profiles: [
    profile('legacy-nut18', 'supported'),
    profile('delivery-v1', 'supported'),
    profile('nut26-nostr', 'unsupported', 'Reference adapter does not implement creqB'),
  ],
};

function upstreamCapabilities(
  implementation: 'cashu-ts' | 'cdk',
  version: string,
): AdapterCapabilities {
  return {
    implementation,
    version,
    nuts: [18, 26],
    transports: ['http', 'nostr'],
    evidenceTier: 'T0',
    encodings: ['creqA', 'creqB'],
    profiles: [
      profile('legacy-nut18', 'supported'),
      profile(
        'delivery-v1',
        'unsupported',
        `${implementation} does not implement the experimental receipt/idempotency profile`,
      ),
      profile('nut26-nostr', 'supported'),
    ],
  };
}

const participants: readonly MatrixParticipant[] = [
  { id: 'reference-ts', capabilities: referenceCapabilities },
  { id: 'cashu-ts', capabilities: upstreamCapabilities('cashu-ts', '4.7.2') },
  { id: 'cdk', capabilities: upstreamCapabilities('cdk', '0.17.3') },
];

function failedScenario(scenario: ScenarioSpec, seed: string, message: string): ScenarioRunResult {
  return {
    status: 'failed',
    error: { name: 'Error', message },
    artifact: {
      schemaVersion: 1,
      seed,
      scenario: scenario.name,
      commands: scenario.commands,
      history: [],
      capabilities: {},
    },
  };
}

export class PackagedLabRuntime implements LabRuntime {
  readonly #services: LabServiceController;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof fetch | undefined;
  readonly #externalFaults: ExternalFaultController;

  constructor(options: PackagedLabRuntimeOptions = {}) {
    this.#services = options.services ?? new DockerComposeServiceController();
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
    const faultUrl = this.#env.CFL_HTTP_FAULT_GATEWAY_URL;
    const faultToken = this.#env.CFL_HTTP_FAULT_GATEWAY_TOKEN;
    if ((faultUrl === undefined) !== (faultToken === undefined)) {
      throw new Error(
        'CFL_HTTP_FAULT_GATEWAY_URL and CFL_HTTP_FAULT_GATEWAY_TOKEN must be configured together',
      );
    }
    this.#externalFaults =
      options.externalFaults ??
      (faultUrl !== undefined && faultToken !== undefined
        ? new HttpExternalFaultController({
            baseUrl: faultUrl,
            token: faultToken,
            ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
          })
        : new DirectExternalFaultController());
  }

  async up(profile: string): Promise<void> {
    await this.#services.up(profile);
  }

  async down(profile: string): Promise<void> {
    await this.#services.down(profile);
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
        faults: this.#externalFaults,
        amount: 8,
        unit: 'sat',
        senderAlias: senderAliases[0]!,
        requestAlias: requestAliases[0]!,
      });
      return new ScenarioRunner(driver).run(scenario, seed);
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
      return runReferenceHttpScenario(scenario, seed);
    }
    if (scenario.name === 'nostr-response-lost') {
      return runReferenceNostrScenario(scenario, seed, 'nostr');
    }
    if (
      scenario.name === 'http-nostr-fallback' ||
      scenario.name === 'cross-transport-duplicate-storm'
    ) {
      return runReferenceNostrScenario(scenario, seed, 'cross');
    }
    if (scenario.name === 'crash-recovery-mint-response-lost') {
      return runReferenceCrashScenario(scenario, seed);
    }
    if (scenario.name.startsWith('security-')) {
      return runReferenceSecurityScenario(scenario, seed);
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
