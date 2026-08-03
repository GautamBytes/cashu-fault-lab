import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  runDoctorMatrix,
  validateWalletDoctorScenario,
  type DoctorRunEndpoints,
  type WalletDoctorScenario,
} from '../src/index.js';

/**
 * Funded lane: every packaged wallet-doctor scenario against the real
 * reference wallet fixture, two real fault relays, and a real Nutshell mint
 * (compose stack from infra/compose/wallet-doctor.compose.yml). Runs only
 * through `pnpm test:doctor:funded`, which sets CFL_WALLET_DOCTOR_E2E.
 */
function endpoints(): DoctorRunEndpoints {
  const fixtureUrl = process.env.CFL_WALLET_DOCTOR_FIXTURE_URL;
  const fixtureToken = process.env.CFL_WALLET_DOCTOR_FIXTURE_TOKEN;
  const relays = (process.env.CFL_WALLET_DOCTOR_RELAYS ?? '')
    .split(',')
    .map((relay) => relay.trim())
    .filter((relay) => relay.length > 0);
  const controls = (process.env.CFL_WALLET_DOCTOR_RELAY_CONTROLS ?? '')
    .split(',')
    .map((control) => control.trim());
  const controlToken = process.env.CFL_WALLET_DOCTOR_RELAY_CONTROL_TOKEN;
  if (fixtureUrl === undefined || fixtureToken === undefined || relays.length === 0) {
    throw new Error(
      'funded wallet-doctor lane requires CFL_WALLET_DOCTOR_FIXTURE_URL/TOKEN and CFL_WALLET_DOCTOR_RELAYS',
    );
  }
  return {
    fixtureUrl,
    fixtureToken,
    relays: relays.map((url, index) => {
      const controlUrl = controls[index];
      return {
        url,
        ...(controlUrl !== undefined && controlUrl !== '' ? { controlUrl } : {}),
        ...(controlToken !== undefined ? { controlToken } : {}),
      };
    }),
  };
}

describe('funded wallet-doctor lane', () => {
  it('every packaged scenario passes against the real mint, relays, and fixture', async () => {
    if (process.env.CFL_WALLET_DOCTOR_E2E !== '1') {
      throw new Error('funded wallet-doctor lane requires pnpm test:doctor:funded');
    }
    const directory = new URL('../../../scenarios/wallet-doctor/', import.meta.url);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
    const scenarios: WalletDoctorScenario[] = [];
    for (const file of files) {
      scenarios.push(
        validateWalletDoctorScenario(JSON.parse(await readFile(new URL(file, directory), 'utf8'))),
      );
    }
    expect(scenarios.length).toBeGreaterThanOrEqual(7);
    // No checkStates hook: capture verifies proofs against the real mint.
    const matrix = await runDoctorMatrix(
      'nip60-doctor-v1',
      scenarios,
      'wallet-doctor-funded',
      endpoints(),
    );
    const failures = matrix.results.filter((result) => result.status !== 'passed');
    expect(
      failures,
      `failing scenarios: ${failures
        .map((result) => `${result.scenarioId}: ${result.failures.join('; ')}`)
        .join(' | ')}`,
    ).toEqual([]);
    expect(matrix.ok).toBe(true);
  }, 300_000);
});
