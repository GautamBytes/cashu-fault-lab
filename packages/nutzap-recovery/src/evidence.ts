import { digest } from './protocol.js';
export interface NutzapEvidence {
  inputAmount: number;
  outputAmount: number;
  fee: number;
  credits: number;
  creditedAmount: number;
  inputProofs: number;
  spentInputs: number;
  outputProofs: number;
  unspentOutputs: number;
  tokenCounts: number[];
  historyCounts: number[];
  relayEventsAgree: boolean;
  historyReferencesMatch: boolean;
  walletPayloadsMatch: boolean;
  faultObserved: boolean;
  killedAfterSwap: boolean;
  completed: boolean;
}
export function verifyNutzapEvidence(
  e: NutzapEvidence,
  scenarioId?: string,
): { ok: boolean; failures: string[] } {
  const proofCount = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 64;
  const checks: Record<string, boolean> = {
    'one-economic-credit': e.credits === 1,
    'value-conserved':
      Number.isSafeInteger(e.inputAmount) &&
      e.inputAmount > 0 &&
      Number.isSafeInteger(e.outputAmount) &&
      e.outputAmount > 0 &&
      Number.isSafeInteger(e.fee) &&
      e.fee >= 0 &&
      e.inputAmount === e.outputAmount + e.fee &&
      e.creditedAmount === e.outputAmount,
    'source-spent': proofCount(e.inputProofs) && e.inputProofs === e.spentInputs,
    'outputs-unspent': proofCount(e.outputProofs) && e.outputProofs === e.unspentOutputs,
    'relay-convergence':
      Array.isArray(e.tokenCounts) &&
      Array.isArray(e.historyCounts) &&
      e.tokenCounts.length === 2 &&
      e.historyCounts.length === 2 &&
      e.tokenCounts.every((n) => n === 1) &&
      e.historyCounts.every((n) => n === 1) &&
      e.relayEventsAgree === true &&
      e.historyReferencesMatch === true,
    'fault-exercised': e.faultObserved === true,
    'crash-confirmed': scenarioId !== 'crash-after-swap' || e.killedAfterSwap === true,
    'wallet-payloads-match': e.walletPayloadsMatch === true,
    recovered: e.completed === true,
  };
  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([id]) => id);
  return { ok: failures.length === 0, failures };
}
export interface NutzapReport {
  schemaVersion: 1;
  suite: 'nip61-recovery-v1';
  scenarioId: string;
  mode: 'simulated' | 'funded';
  seedHash: string;
  status: 'passed' | 'failed';
  evidence: NutzapEvidence;
  failures: string[];
  fingerprint: string;
  implementations: { receiver: string; mint: string; relay: string };
}
export function evidenceFingerprint(e: NutzapEvidence): string {
  return digest(
    `nip61-recovery-evidence-v1\0${JSON.stringify(Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b))))}`,
  );
}
