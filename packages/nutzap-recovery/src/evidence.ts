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
  postSpend?: {
    amount: number;
    fee: number;
    remaining: number;
    recipientAmount: number;
    recipientFee: number;
    walletBalances: number[];
    credits: number;
    staleBalance: number;
    originalProofs: number;
    spentOriginalProofs: number;
    changeProofs: number;
    unspentChangeProofs: number;
    sentProofs: number;
    spentSentProofs: number;
    recipientProofs: number;
    unspentRecipientProofs: number;
    staleOnlyObserved: boolean;
    deletionFirstObserved: boolean;
    replacementFirstObserved: boolean;
    reorderedHistoryObserved: boolean;
    retiredTokenRejected: boolean;
    publicationCrashObserved: boolean;
    outboxStable: boolean;
    relayEventsAgree: boolean;
  };
  crossLanguage?: {
    receivers: string[];
    cdkProcessObserved: boolean;
    crashedReceiver: 'none' | 'cashu-ts' | 'cdk';
    privateJournals: boolean;
    postSpend?: {
      spender: 'cdk' | 'cashu-ts';
      cdkSpendObserved: boolean;
      cdkSyncObserved: boolean;
      databasesDistinct: boolean;
    };
  };
  independent?: {
    databasesDistinct: boolean;
    plansDistinct: boolean;
    swapAttempts: number;
    successfulSwaps: number;
    localCredits: number[];
    replicatedWallets: number;
    walletBalances: number[];
    walletEventsAgree: boolean;
    awaitingPeerObserved: boolean;
    relayOutageObserved: boolean;
  };
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
    'crash-confirmed':
      ![
        'crash-after-swap',
        'independent-crash-after-swap',
        'cdk-crash-after-swap',
        'cdk-peer-crash-after-swap',
      ].includes(scenarioId ?? '') || e.killedAfterSwap === true,
    'wallet-payloads-match': e.walletPayloadsMatch === true,
    recovered: e.completed === true,
  };
  if (
    scenarioId?.startsWith('independent-') ||
    (scenarioId?.startsWith('cdk-') && !scenarioId.includes('post-spend-'))
  ) {
    const i = e.independent;
    checks['independent-wallets'] =
      !!i &&
      i.databasesDistinct === true &&
      i.plansDistinct === true &&
      i.swapAttempts === 2 &&
      i.successfulSwaps === 1 &&
      i.replicatedWallets === 1 &&
      Array.isArray(i.localCredits) &&
      JSON.stringify([...i.localCredits].sort()) === '[0,1]' &&
      Array.isArray(i.walletBalances) &&
      i.walletBalances.length === 2 &&
      i.walletBalances.every((n) => n === e.outputAmount) &&
      i.walletEventsAgree === true &&
      i.awaitingPeerObserved === true;
    checks['relay-outage'] =
      scenarioId !== 'independent-relay-outage' || i?.relayOutageObserved === true;
  }
  if (scenarioId?.startsWith('cdk-')) {
    const c = e.crossLanguage;
    checks['cross-language-receivers'] =
      !!c &&
      c.cdkProcessObserved === true &&
      c.privateJournals === true &&
      JSON.stringify(c.receivers) === '["cashu-ts/4.7.2","cdk/0.17.3 + nostr/0.45.5"]' &&
      c.crashedReceiver ===
        (scenarioId.includes('post-spend-publication-crash')
          ? scenarioId.startsWith('cdk-peer-')
            ? 'cashu-ts'
            : 'cdk'
          : scenarioId === 'cdk-crash-after-swap'
            ? 'cdk'
            : scenarioId === 'cdk-peer-crash-after-swap'
              ? 'cashu-ts'
              : 'none');
  }
  if (scenarioId?.startsWith('cdk-') && scenarioId.includes('post-spend-')) {
    const p = e.crossLanguage?.postSpend;
    const cdkSpends = !scenarioId.startsWith('cdk-peer-');
    checks['native-post-spend'] =
      !!p &&
      p.spender === (cdkSpends ? 'cdk' : 'cashu-ts') &&
      p.cdkSpendObserved === cdkSpends &&
      p.cdkSyncObserved === true &&
      p.databasesDistinct === true;
  }
  if (scenarioId?.includes('post-spend-')) {
    const p = e.postSpend;
    checks['post-spend-value'] =
      !!p &&
      [p.amount, p.fee, p.remaining, p.recipientAmount, p.recipientFee].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      p.amount > 0 &&
      p.remaining > 0 &&
      p.recipientAmount > 0 &&
      e.outputAmount === p.amount + p.fee + p.remaining &&
      p.amount === p.recipientAmount + p.recipientFee;
    checks['post-spend-states'] =
      !!p &&
      proofCount(p.originalProofs) &&
      p.originalProofs === p.spentOriginalProofs &&
      proofCount(p.changeProofs) &&
      p.changeProofs === p.unspentChangeProofs &&
      proofCount(p.sentProofs) &&
      p.sentProofs === p.spentSentProofs &&
      proofCount(p.recipientProofs) &&
      p.recipientProofs === p.unspentRecipientProofs;
    checks['post-spend-convergence'] =
      !!p &&
      p.credits === 1 &&
      p.staleBalance === 0 &&
      Array.isArray(p.walletBalances) &&
      p.walletBalances.length === 2 &&
      p.walletBalances.every((n) => n === p.remaining) &&
      p.staleOnlyObserved === true &&
      p.deletionFirstObserved === true &&
      p.replacementFirstObserved === true &&
      p.reorderedHistoryObserved === true &&
      p.retiredTokenRejected === true &&
      p.outboxStable === true &&
      p.relayEventsAgree === true;
    checks['post-spend-crash'] =
      !!p && p.publicationCrashObserved === scenarioId.endsWith('publication-crash');
  }
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
