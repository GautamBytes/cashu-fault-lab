import { Option, type Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { nip19 } from 'nostr-tools';
import {
  assertNip60Capture,
  captureWallet,
  type Nip60Capture,
} from '@cashu-fault-lab/wallet-doctor-contract';
import {
  checkCapture,
  diagnoseCapture,
  executeDoctorScenario,
  planForDiagnosis,
  replayDoctorScenario,
  runDoctorMatrix,
  validateWalletDoctorScenario,
  type DoctorRunEndpoints,
  type WalletDoctorScenario,
  type WalletDoctorScenarioArtifact,
} from '@cashu-fault-lab/wallet-doctor-runner';
import { runtimeAssetPath } from '../runtime-assets.js';
import type { CliIo, CliOutcome } from '../index.js';

export interface WalletDoctorCommandContext {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
  readonly distribution: 'workspace' | 'package';
  readonly setExitCode: (exitCode: CliOutcome['exitCode']) => void;
}

const DEFAULT_SUBJECT_KEY_ENV = 'CFL_NIP60_SUBJECT_KEY';
const DEFAULT_CAPTURE_DIR = 'artifacts/wallet-doctor';
const DEFAULT_SEED = 'cashu-fault-lab-wallet-doctor';
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_SCENARIO_BYTES = 262_144;

async function loadScenario(
  io: CliIo,
  distribution: 'workspace' | 'package',
  reference: string,
): Promise<WalletDoctorScenario> {
  if (reference.includes('..') || reference.includes('\\')) {
    throw new Error('wallet-doctor scenario reference is invalid');
  }
  const candidates = SCENARIO_ID.test(reference)
    ? [`scenarios/wallet-doctor/${reference}.json`]
    : [reference.endsWith('.json') ? reference : `${reference}.json`];
  const resolved =
    distribution === 'package'
      ? candidates.flatMap((candidate) => [runtimeAssetPath(candidate), candidate])
      : candidates;
  let raw: string | undefined;
  for (const candidate of resolved) {
    try {
      raw = await io.readText(candidate);
      break;
    } catch {
      // Try the next candidate path.
    }
  }
  if (raw === undefined) {
    throw new Error(`wallet-doctor scenario was not found: ${reference}`);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SCENARIO_BYTES) {
    throw new Error('wallet-doctor scenario exceeds the size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`wallet-doctor scenario at ${reference} is not valid JSON`);
  }
  return validateWalletDoctorScenario(parsed);
}

async function loadScenarioDir(
  io: CliIo,
  distribution: 'workspace' | 'package',
): Promise<readonly WalletDoctorScenario[]> {
  const directory = runtimeAssetPath('scenarios/wallet-doctor');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no wallet-doctor scenarios found in ${directory}`);
  const scenarios: WalletDoctorScenario[] = [];
  for (const file of files) {
    const raw = await io.readText(`${directory}/${file}`);
    scenarios.push(validateWalletDoctorScenario(JSON.parse(raw)));
  }
  return scenarios;
}

function endpointsFromEnv(env: NodeJS.ProcessEnv): DoctorRunEndpoints {
  const fixtureUrl = env.CFL_WALLET_DOCTOR_FIXTURE_URL;
  const fixtureToken = env.CFL_WALLET_DOCTOR_FIXTURE_TOKEN;
  if (
    fixtureUrl === undefined ||
    fixtureUrl === '' ||
    fixtureToken === undefined ||
    fixtureToken === ''
  ) {
    throw new Error(
      'wallet-doctor scenarios require CFL_WALLET_DOCTOR_FIXTURE_URL and CFL_WALLET_DOCTOR_FIXTURE_TOKEN',
    );
  }
  const relays = (env.CFL_WALLET_DOCTOR_RELAYS ?? '')
    .split(',')
    .map((relay) => relay.trim())
    .filter((relay) => relay.length > 0);
  if (relays.length === 0) {
    throw new Error('CFL_WALLET_DOCTOR_RELAYS must list at least one relay url');
  }
  const controls = (env.CFL_WALLET_DOCTOR_RELAY_CONTROLS ?? '')
    .split(',')
    .map((control) => control.trim());
  const controlToken = env.CFL_WALLET_DOCTOR_RELAY_CONTROL_TOKEN;
  return {
    fixtureUrl,
    fixtureToken,
    relays: relays.map((url, index) => {
      const controlUrl = controls[index];
      return {
        url,
        ...(controlUrl !== undefined && controlUrl !== '' ? { controlUrl } : {}),
        ...(controlToken !== undefined && controlToken !== '' ? { controlToken } : {}),
      };
    }),
  };
}

function renderScenarioResult(artifact: WalletDoctorScenarioArtifact): string {
  const lines = [
    `scenario: ${artifact.scenarioId} (${artifact.passed ? 'PASS' : 'FAIL'})\n`,
    `codes: ${artifact.actual.codes.join(', ') || '(none)'}\n`,
    `balance: merged=${artifact.actual.merged} mint-verified=${artifact.actual.mintVerified} ` +
      `double-counted=${artifact.actual.doubleCounted} ghost=${artifact.actual.ghost} ` +
      `orphaned-unspent=${artifact.actual.orphanedUnspent}\n`,
  ];
  if (artifact.failures.length > 0) {
    lines.push(`failures:\n${artifact.failures.map((failure) => `  - ${failure}\n`).join('')}`);
  }
  return lines.join('');
}

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function assertRelayUrl(value: string): string {
  if (!value.startsWith('ws://') && !value.startsWith('wss://')) {
    throw new Error(`relay url must start with ws:// or wss://: ${value}`);
  }
  return value;
}

function subjectKeyFromEnv(env: NodeJS.ProcessEnv, variable: string): Uint8Array {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `subject key is missing: set ${variable} to an nsec1… or 64-hex Nostr secret key`,
    );
  }
  const value = raw.trim();
  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
      throw new Error(`${variable} is not a valid nsec key`);
    }
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/u.test(value)) {
    return Uint8Array.from(Buffer.from(value, 'hex'));
  }
  throw new Error(`${variable} must hold an nsec1… or 64-hex Nostr secret key`);
}

async function readCapture(io: CliIo, path: string): Promise<Nip60Capture> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await io.readText(path)) as unknown;
  } catch (error) {
    throw new Error(
      `capture at ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertNip60Capture(parsed);
}

function renderFindingLines(
  findings: ReadonlyArray<{
    readonly severity: string;
    readonly code: string;
    readonly summary: string;
  }>,
): string {
  if (findings.length === 0) return '  (no findings)\n';
  return findings
    .map((finding) => `  [${finding.severity}] ${finding.code}: ${finding.summary}\n`)
    .join('');
}

function renderBalance(balance: {
  readonly naiveMerged: number;
  readonly merged: number;
  readonly mintVerified: number;
  readonly doubleCounted: number;
  readonly ghost: number;
  readonly orphanedUnspent: number;
}): string {
  return (
    `balance: merged=${balance.merged} naive=${balance.naiveMerged} ` +
    `mint-verified=${balance.mintVerified} double-counted=${balance.doubleCounted} ` +
    `ghost=${balance.ghost} orphaned-unspent=${balance.orphanedUnspent}\n`
  );
}

function renderRelayStatus(capture: Nip60Capture): string {
  const ok = capture.observation.relays.filter((relay) => relay.status === 'ok').length;
  const failed = capture.observation.relays.length - ok;
  return `subject: ${capture.subject}\nrelays: ${ok} ok, ${failed} error\n`;
}

export function registerWalletDoctorCommands(
  program: Command,
  context: WalletDoctorCommandContext,
): void {
  const { io, env, distribution, setExitCode } = context;

  const walletDoctor = program
    .command('wallet-doctor')
    .description(
      'Diagnose NIP-60 wallet state across Nostr relays (read-only, dry-run repair plans)',
    );

  walletDoctor
    .command('collect')
    .description('Fetch NIP-60 events from relays and verify proofs against their mints')
    .option('--relay <url>', 'relay url (repeatable)', collect, [])
    .option('--nsec-env <var>', 'env var holding the subject secret key', DEFAULT_SUBJECT_KEY_ENV)
    .option('--pubkey <hex>', 'subject pubkey for keyless raw capture (no decryption)')
    .option('--timeout-ms <ms>', 'per-relay and per-mint timeout', '10000')
    .option('--output <path>', 'write the capture bundle', `${DEFAULT_CAPTURE_DIR}/capture.json`)
    .action(
      async (options: {
        relay: string[];
        nsecEnv: string;
        pubkey?: string;
        timeoutMs: string;
        output: string;
      }) => {
        if (options.relay.length === 0) {
          throw new Error('at least one --relay <url> is required');
        }
        const timeoutMs = Number.parseInt(options.timeoutMs, 10);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
          throw new Error('--timeout-ms must be an integer from 100 to 300000');
        }
        const relays = options.relay.map(assertRelayUrl);
        const capture = await captureWallet({
          relays,
          ...(options.pubkey === undefined
            ? { subjectSecretKey: subjectKeyFromEnv(env, options.nsecEnv) }
            : { subjectPubkey: options.pubkey }),
          timeoutMs,
        });
        await io.writeText(options.output, `${JSON.stringify(capture, null, 2)}\n`);
        io.stdout(renderRelayStatus(capture));
        io.stdout(`capture: ${options.output} (${capture.digest})\n`);
      },
    );

  walletDoctor
    .command('diagnose')
    .description('Explain why relays disagree about one wallet')
    .argument('<capture>', 'capture bundle path')
    .option(
      '--output <path>',
      'write the diagnosis artifact',
      `${DEFAULT_CAPTURE_DIR}/diagnosis.json`,
    )
    .addOption(
      new Option('--format <format>', 'diagnosis report format').choices(['json']).default('json'),
    )
    .action(async (path: string, options: { output: string }) => {
      const capture = await readCapture(io, path);
      const artifact = diagnoseCapture(capture);
      await io.writeText(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
      io.stdout(renderRelayStatus(capture));
      io.stdout(renderBalance(artifact.diagnosis.balance));
      io.stdout(renderFindingLines(artifact.diagnosis.findings));
      io.stdout(`diagnosis: ${options.output}\n`);
      if (!artifact.diagnosis.ok) setExitCode(1);
    });

  walletDoctor
    .command('plan')
    .description('Emit a dry-run repair plan with safety invariants (nothing is published)')
    .argument('<capture>', 'capture bundle path')
    .option('--output <path>', 'write the repair plan artifact', `${DEFAULT_CAPTURE_DIR}/plan.json`)
    .action(async (path: string, options: { output: string }) => {
      const capture = await readCapture(io, path);
      const artifact = planForDiagnosis(capture, diagnoseCapture(capture));
      await io.writeText(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
      const stepLines =
        artifact.plan.steps.length === 0
          ? '  (no repair steps needed)\n'
          : artifact.plan.steps
              .map((step) => {
                if (step.action === 'publish_rollover') {
                  return `  rollover ${step.rolloverId} on ${step.mint}: covers ${step.coveredYs.length} proof(s), destroys ${step.del.length} event(s)\n`;
                }
                if (step.action === 'delete_events') {
                  return `  delete ${step.eventIds.length} event(s) on ${step.toRelays.length} relay(s)\n`;
                }
                if (step.action === 'republish_event' || step.action === 'republish_wallet_event') {
                  return `  republish ${step.eventId} to ${step.toRelays.join(', ')}\n`;
                }
                return `  wallet action: ${step.kind} for ${step.ys.length} proof(s) on ${step.mint}\n`;
              })
              .join('');
      io.stdout(`plan steps:\n${stepLines}`);
      io.stdout(
        `safety: ${artifact.safety.ok ? 'ok' : `VIOLATIONS: ${artifact.safety.violations.join('; ')}`}\n`,
      );
      io.stdout(`plan: ${options.output} (dry-run; nothing is published)\n`);
      if (!artifact.safety.ok) setExitCode(1);
    });

  walletDoctor
    .command('check')
    .description('CI gate: diagnosis plus safe repair plan, exit code reflects findings')
    .argument('<capture>', 'capture bundle path')
    .option('--output <path>', 'write the combined check artifact')
    .action(async (path: string, options: { output?: string }) => {
      const capture = await readCapture(io, path);
      const result = checkCapture(capture);
      if (options.output !== undefined) {
        await io.writeText(
          options.output,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              kind: 'nip60-check',
              generatedFrom: capture.digest,
              ok: result.ok,
              summary: result.summary,
              diagnosis: result.diagnosisArtifact,
              plan: result.planArtifact,
            },
            null,
            2,
          )}\n`,
        );
      }
      io.stdout(renderRelayStatus(capture));
      io.stdout(renderBalance(result.diagnosisArtifact.diagnosis.balance));
      io.stdout(renderFindingLines(result.diagnosisArtifact.diagnosis.findings));
      io.stdout(
        `check: ${result.ok ? 'PASS' : 'FAIL'} (${result.summary.errorFindings} error, ` +
          `${result.summary.warningFindings} warning, ${result.summary.infoFindings} info, ` +
          `${result.summary.failedRelays} relay failed)\n`,
      );
      if (!result.ok) setExitCode(1);
    });

  walletDoctor
    .command('run')
    .description('Run one wallet-doctor scenario against a live fixture/relay/mint stack')
    .argument('<scenario>', 'packaged scenario id or relative JSON path')
    .option('--seed <seed>', 'deterministic seed', DEFAULT_SEED)
    .option(
      '--output <path>',
      'write the scenario artifact (default artifacts/wallet-doctor/<id>.json)',
    )
    .action(async (reference: string, options: { seed: string; output?: string }) => {
      const scenario = await loadScenario(io, distribution, reference);
      const endpoints = endpointsFromEnv(env);
      const artifact = await executeDoctorScenario(scenario, options.seed, endpoints);
      const output = options.output ?? `${DEFAULT_CAPTURE_DIR}/${scenario.id}.json`;
      await io.writeText(output, `${JSON.stringify(artifact, null, 2)}\n`);
      io.stdout(renderScenarioResult(artifact));
      io.stdout(`artifact: ${output}\n`);
      if (!artifact.passed) setExitCode(1);
    });

  walletDoctor
    .command('matrix')
    .description('Run every packaged wallet-doctor scenario')
    .addOption(
      new Option('--profile <profile>', 'matrix profile')
        .choices(['nip60-doctor-v1'])
        .default('nip60-doctor-v1'),
    )
    .option('--seed <seed>', 'deterministic seed', DEFAULT_SEED)
    .option('--json', 'emit machine-readable matrix results', false)
    .option('--output <path>', 'write matrix output')
    .action(async (options: { profile: string; seed: string; json: boolean; output?: string }) => {
      const scenarios = await loadScenarioDir(io, distribution);
      const endpoints = endpointsFromEnv(env);
      const result = await runDoctorMatrix(options.profile, scenarios, options.seed, endpoints);
      if (options.output !== undefined) {
        await io.writeText(options.output, `${JSON.stringify(result, null, 2)}\n`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(result)}\n`);
      } else {
        for (const entry of result.results) {
          io.stdout(`  ${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${entry.scenarioId}\n`);
          for (const failure of entry.failures) io.stdout(`    - ${failure}\n`);
        }
        io.stdout(`matrix ${result.profile}: ${result.passed} passed, ${result.failed} failed\n`);
      }
      if (!result.ok) setExitCode(1);
    });

  walletDoctor
    .command('replay')
    .description('Replay a wallet-doctor scenario artifact with its original seed')
    .argument('<artifact>', 'scenario artifact JSON')
    .option('--seed <seed>', 'original seed supplied out of band', DEFAULT_SEED)
    .action(async (path: string, options: { seed: string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await io.readText(path)) as unknown;
      } catch {
        throw new Error(`artifact at ${path} is not readable JSON`);
      }
      const artifact = parsed as WalletDoctorScenarioArtifact;
      if (artifact.kind !== 'nip60-scenario-result' || typeof artifact.scenarioId !== 'string') {
        throw new Error(`artifact at ${path} is not a nip60-scenario-result`);
      }
      const scenario = await loadScenario(io, distribution, artifact.scenarioId);
      const endpoints = endpointsFromEnv(env);
      const result = await replayDoctorScenario(artifact, scenario, options.seed, endpoints);
      io.stdout(
        `replay: ${result.verified ? 'VERIFIED' : 'DIVERGED'} (${artifact.scenarioId})\n` +
          renderScenarioResult(result.artifact),
      );
      if (result.differences.length > 0) {
        io.stdout(`differences:\n${result.differences.map((line) => `  - ${line}\n`).join('')}`);
      }
      if (!result.verified) setExitCode(1);
    });
}
