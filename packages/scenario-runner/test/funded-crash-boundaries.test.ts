import {
  HttpAdapterClient,
  type CrashArmInput,
  type CrashArmStatus,
} from '@cashu-fault-lab/adapter-contract';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExternalAdapterScenarioDriver,
  ScenarioRunner,
  type ExternalFaultController,
  type ScenarioSpec,
} from '../src/index.js';

const enabled = process.env.CFL_FUNDED_CRASH_E2E === '1';
const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const composeFile = fileURLToPath(
  new URL('../../../infra/compose/wallet-adapters.compose.yml', import.meta.url),
);
const token = process.env.CFL_CASHU_TS_TOKEN ?? '';
const boundaryScenarios = [
  'sender_before_proof_reservation',
  'sender_after_reservation_before_payload_persistence',
  'sender_after_payload_persistence_before_network_send',
  'sender_after_send_before_response',
  'receiver_before_mint_request',
  'receiver_after_mint_request_before_response',
  'receiver_after_mint_response_before_output_persistence',
  'receiver_after_output_persistence_before_merchant_credit',
  'receiver_after_credit_before_receipt_persistence',
  'receiver_after_receipt_persistence_before_response_or_outbox',
] as const;

class AdapterCrashController implements ExternalFaultController {
  readonly #client: HttpAdapterClient;

  constructor(client: HttpAdapterClient) {
    this.#client = client;
  }

  async reset(): Promise<void> {}
  async configure(): Promise<void> {}
  async clear(): Promise<void> {}

  async evidence() {
    return { inbound: 0, forwarded: 0, controller: 'direct' as const };
  }

  armCrash(input: CrashArmInput): Promise<void> {
    return this.#client.armCrash(input);
  }

  crashStatus(): Promise<readonly CrashArmStatus[]> {
    return this.#client.crashStatus();
  }
}

async function scenario(name: string): Promise<ScenarioSpec> {
  const path = new URL(
    `../../../scenarios/crash-recovery/boundaries/${name}.json`,
    import.meta.url,
  );
  return JSON.parse(await readFile(path, 'utf8')) as ScenarioSpec;
}

describe.skipIf(!enabled)('funded cashu-ts process crash boundaries', () => {
  let client: HttpAdapterClient;

  beforeAll(async () => {
    if (token.length === 0) throw new Error('CFL_CASHU_TS_TOKEN is required');
    await execFileAsync('docker', ['compose', '-f', composeFile, 'up', '--build', '-d', '--wait'], {
      cwd: root,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    client = new HttpAdapterClient({
      baseUrl: 'http://127.0.0.1:4101',
      token,
      timeoutMs: 30_000,
    });
  }, 300_000);

  afterAll(async () => {
    await execFileAsync('docker', ['compose', '-f', composeFile, 'down', '-v'], {
      cwd: root,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => undefined);
  }, 60_000);

  it.each(boundaryScenarios)(
    'recovers a real process at %s',
    async (name) => {
      const selected = await scenario(name);
      const seed = `funded-${name.replaceAll('_', '-')}`;
      const driver = new ExternalAdapterScenarioDriver({
        sender: client,
        receiver: client,
        faults: new AdapterCrashController(client),
        amount: 8,
        unit: 'sat',
        transports: ['http'],
        senderAlias: 'reference',
        requestAlias: 'AAECAwQFBgcICQoLDA0ODw',
        maxAttempts: 5,
        retryDelayMs: 250,
        restartReadinessAttempts: 120,
        restartReadinessDelayMs: 500,
      });

      const result = await new ScenarioRunner(driver).run(selected, seed);

      expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' });
      expect(await client.crashStatus()).toEqual([
        expect.objectContaining({
          runId: seed,
          boundary: name,
          hits: 1,
          consumed: true,
        }),
      ]);
      expect(result.artifact.invariants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'at-most-one-merchant-credit-per-delivery',
            status: 'passed',
          }),
          expect.objectContaining({ id: 'proof-set-exclusivity', status: 'passed' }),
          expect.objectContaining({ id: 'crash-recovery', status: 'passed' }),
        ]),
      );
    },
    120_000,
  );
});
