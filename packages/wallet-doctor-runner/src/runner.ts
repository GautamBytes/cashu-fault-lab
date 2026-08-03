import { captureWallet, type CaptureOptions } from '@cashu-fault-lab/wallet-doctor-contract';
import { checkCapture, type WalletDoctorCheck } from './pipeline.js';
import {
  doctorSeedHash,
  type WalletDoctorScenario,
  type WalletDoctorScenarioExpect,
  type WalletDoctorScenarioStep,
} from './scenario.js';
import type { Nip60Capture } from '@cashu-fault-lab/wallet-doctor-contract';

export interface DoctorRelayEndpoint {
  /** Relay url as seen by the doctor harness (loopback-published). */
  readonly url: string;
  /** Optional fault-control base url for relay-partition steps. */
  readonly controlUrl?: string;
  readonly controlToken?: string;
}

export interface DoctorRunEndpoints {
  readonly fixtureUrl: string;
  readonly fixtureToken: string;
  readonly relays: readonly DoctorRelayEndpoint[];
}

/** Test hooks replacing live mint truth; never set in production lanes. */
export interface DoctorRunHooks {
  readonly checkStates?: CaptureOptions['checkStates'];
}

export interface WalletDoctorScenarioArtifact {
  readonly schemaVersion: 1;
  readonly kind: 'nip60-scenario-result';
  readonly scenarioId: string;
  readonly seedHash: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly expected: WalletDoctorScenarioExpect;
  readonly actual: {
    readonly codes: readonly string[];
    readonly ok: boolean;
    readonly doubleCounted: number;
    readonly mintVerified: number;
    readonly merged: number;
    readonly ghost: number;
    readonly orphanedUnspent: number;
  };
  readonly captureDigest: string;
  readonly diagnosis: WalletDoctorCheck['diagnosisArtifact'];
  readonly plan: WalletDoctorCheck['planArtifact'];
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function fixtureRequest(
  endpoints: DoctorRunEndpoints,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoints.fixtureUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${endpoints.fixtureToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const parsed = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        typeof parsed === 'object' && parsed !== null && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : `HTTP ${response.status}`;
      throw new Error(`fixture ${method} ${path} failed: ${message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`fixture ${method} ${path} returned an invalid body`);
    }
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

async function relayControl(
  relay: DoctorRelayEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  if (relay.controlUrl === undefined) {
    throw new Error(`relay ${relay.url} has no fault-control endpoint configured`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${relay.controlUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${relay.controlToken ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`relay control ${method} ${path} returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function runStep(
  endpoints: DoctorRunEndpoints,
  step: WalletDoctorScenarioStep,
): Promise<void> {
  if (step.op === 'mint') {
    await fixtureRequest(endpoints, 'POST', '/v1/doctor-wallet/mint', { amount: step.amount });
    return;
  }
  if (step.op === 'spend') {
    await fixtureRequest(endpoints, 'POST', '/v1/doctor-wallet/spend', {
      amount: step.amount,
      mode: step.mode,
    });
    return;
  }
  const relay = endpoints.relays[step.relay ?? -1];
  if (relay === undefined) {
    throw new Error(
      `step targets relay index ${step.relay} but only ${endpoints.relays.length} relay(s) are configured`,
    );
  }
  if (step.op === 'relay-partition') {
    await relayControl(relay, 'POST', '/v1/faults/partition', {
      eventIds: step.eventIds ?? [],
      kinds: step.kinds ?? [],
      authors: step.authors ?? [],
    });
    return;
  }
  await relayControl(relay, 'DELETE', '/v1/faults');
}

function compareExpectations(
  expect: WalletDoctorScenarioExpect,
  check: WalletDoctorCheck,
): { failures: string[]; actual: WalletDoctorScenarioArtifact['actual'] } {
  const balance = check.diagnosisArtifact.diagnosis.balance;
  const actual: WalletDoctorScenarioArtifact['actual'] = {
    codes: check.summary.codes,
    ok: check.diagnosisArtifact.diagnosis.ok,
    doubleCounted: balance.doubleCounted,
    mintVerified: balance.mintVerified,
    merged: balance.merged,
    ghost: balance.ghost,
    orphanedUnspent: balance.orphanedUnspent,
  };
  const failures: string[] = [];
  // Compare canonically: finding order is severity-major, expectations are
  // alphabetical, so both sides are sorted before comparison.
  const actualCodes = [...actual.codes].sort();
  const expectedCodes = [...expect.codes].sort();
  if (actualCodes.join(',') !== expectedCodes.join(',')) {
    failures.push(
      `codes: expected ${expectedCodes.join(',') || '(none)'}, got ${actualCodes.join(',') || '(none)'}`,
    );
  }
  if (actual.ok !== expect.ok) failures.push(`ok: expected ${expect.ok}, got ${actual.ok}`);
  for (const field of [
    'doubleCounted',
    'mintVerified',
    'merged',
    'ghost',
    'orphanedUnspent',
  ] as const) {
    const wanted = expect[field];
    if (wanted !== undefined && actual[field] !== wanted) {
      failures.push(`${field}: expected ${wanted}, got ${actual[field]}`);
    }
  }
  return { failures, actual };
}

/**
 * Execute one scenario against a live fixture/relay/mint stack: reset the
 * fixture with the scenario seed, drive the steps, capture the resulting
 * relay state, and compare the diagnosis with the scenario expectations.
 */
export async function executeDoctorScenario(
  scenario: WalletDoctorScenario,
  seed: string,
  endpoints: DoctorRunEndpoints,
  hooks: DoctorRunHooks = {},
): Promise<WalletDoctorScenarioArtifact> {
  const seedHash = doctorSeedHash(seed);
  // Reset relay storage before the fixture: scenarios and replays must start
  // from empty relays (replay reuses the same subject key by design).
  for (const relay of endpoints.relays) {
    if (relay.controlUrl !== undefined) {
      await relayControl(relay, 'POST', '/v1/faults/reset');
    }
  }
  await fixtureRequest(endpoints, 'POST', '/v1/doctor-wallet/reset', {
    seed: `doctor\0${seed}\0${scenario.id}`,
  });
  for (const step of scenario.commands) {
    await runStep(endpoints, step);
  }
  const subject = await fixtureRequest(endpoints, 'GET', '/v1/doctor-wallet/subject');
  if (typeof subject.secretKeyHex !== 'string' || !/^[0-9a-f]{64}$/u.test(subject.secretKeyHex)) {
    throw new Error('fixture returned an invalid subject key');
  }
  const capture: Nip60Capture = await captureWallet({
    relays: endpoints.relays.map((relay) => relay.url),
    subjectSecretKey: Uint8Array.from(Buffer.from(subject.secretKeyHex, 'hex')),
    ...(hooks.checkStates === undefined ? {} : { checkStates: hooks.checkStates }),
  });
  const check = checkCapture(capture);
  const { failures, actual } = compareExpectations(scenario.expect, check);
  return {
    schemaVersion: 1,
    kind: 'nip60-scenario-result',
    scenarioId: scenario.id,
    seedHash,
    passed: failures.length === 0,
    failures,
    expected: scenario.expect,
    actual,
    captureDigest: capture.digest,
    diagnosis: check.diagnosisArtifact,
    plan: check.planArtifact,
  };
}

export interface DoctorReplayResult {
  readonly verified: boolean;
  readonly differences: readonly string[];
  readonly artifact: WalletDoctorScenarioArtifact;
}

/**
 * Replay a scenario artifact with the original seed. Replay verifies the seed
 * hash and that the re-executed scenario reproduces the same diagnosis codes
 * and balance explanation; event ids and proof `y` values are fresh on every
 * execution and are intentionally not compared.
 */
export async function replayDoctorScenario(
  artifact: WalletDoctorScenarioArtifact,
  scenario: WalletDoctorScenario,
  seed: string,
  endpoints: DoctorRunEndpoints,
  hooks: DoctorRunHooks = {},
): Promise<DoctorReplayResult> {
  if (artifact.seedHash !== doctorSeedHash(seed)) {
    throw new Error('the supplied seed does not match the artifact seed hash');
  }
  if (artifact.scenarioId !== scenario.id) {
    throw new Error(`artifact scenario ${artifact.scenarioId} does not match ${scenario.id}`);
  }
  const rerun = await executeDoctorScenario(scenario, seed, endpoints, hooks);
  const differences: string[] = [];
  if (rerun.actual.codes.join(',') !== artifact.actual.codes.join(',')) {
    differences.push(
      `codes: artifact ${artifact.actual.codes.join(',')}, replay ${rerun.actual.codes.join(',')}`,
    );
  }
  for (const field of [
    'ok',
    'doubleCounted',
    'mintVerified',
    'merged',
    'ghost',
    'orphanedUnspent',
  ] as const) {
    if (rerun.actual[field] !== artifact.actual[field]) {
      differences.push(
        `${field}: artifact ${artifact.actual[field]}, replay ${rerun.actual[field]}`,
      );
    }
  }
  return { verified: differences.length === 0 && rerun.passed, differences, artifact: rerun };
}

export interface DoctorMatrixResult {
  readonly profile: string;
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly {
    readonly scenarioId: string;
    readonly status: 'passed' | 'failed';
    readonly failures: readonly string[];
  }[];
}

export async function runDoctorMatrix(
  profile: string,
  scenarios: readonly WalletDoctorScenario[],
  seed: string,
  endpoints: DoctorRunEndpoints,
  hooks: DoctorRunHooks = {},
): Promise<DoctorMatrixResult> {
  const results: DoctorMatrixResult['results'][number][] = [];
  for (const scenario of scenarios) {
    try {
      const artifact = await executeDoctorScenario(
        scenario,
        `${seed}-${scenario.id}`,
        endpoints,
        hooks,
      );
      results.push({
        scenarioId: scenario.id,
        status: artifact.passed ? 'passed' : 'failed',
        failures: artifact.failures,
      });
    } catch (error) {
      results.push({
        scenarioId: scenario.id,
        status: 'failed',
        failures: [`execution error: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }
  const passed = results.filter((result) => result.status === 'passed').length;
  return {
    profile,
    ok: passed === results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
