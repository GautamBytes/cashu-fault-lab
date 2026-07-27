import { type AdapterClient, type AdapterTransport } from '@cashu-fault-lab/adapter-contract';
import type { Observation } from '@cashu-fault-lab/oracle';
import {
  DirectExternalFaultController,
  ExternalAdapterScenarioDriver,
} from './external-adapter-driver.js';
import type { MatrixExecutionResult } from './matrix.js';
import { ScenarioRunner, type FailureArtifact, type ScenarioError } from './runner.js';

const DELIVERY_PROFILE = 'delivery-v1';
const SCENARIO_SENDER = 'external-sender';
const SCENARIO_REQUEST = 'external-request';

export interface ExternalDeliveryPairInput {
  readonly profile: string;
  readonly seed: string;
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly amount: number;
  readonly unit: string;
  readonly transports?: readonly AdapterTransport[];
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function failure(code: string, reason: string): MatrixExecutionResult {
  return { ok: false, code, reason };
}

function observations(artifact: FailureArtifact): readonly Observation[] {
  return artifact.history.flatMap((event) => {
    if (event.phase !== 'observation') return [];
    const value = event.data as Observation;
    return typeof value?.type === 'string' ? [value] : [];
  });
}

function proofState(value: string | undefined): string | undefined {
  if (value === 'UNSPENT') return 'unspent';
  if (value === 'PENDING') return 'pending';
  if (value === 'SPENT') return 'spent';
  return undefined;
}

function passedEvidence(
  artifact: FailureArtifact,
  seed: string,
  transports: readonly AdapterTransport[],
): MatrixExecutionResult {
  const all = observations(artifact);
  const receipt = all
    .filter((observation) => observation.type === 'receipt_observed')
    .sort((left, right) =>
      left.type === 'receipt_observed' && right.type === 'receipt_observed'
        ? right.version - left.version
        : 0,
    )[0];
  const creditCount = all.filter((observation) => observation.type === 'merchant_credited').length;
  const proof = all.find((observation) => observation.type === 'mint_proofs_state');
  const delivery = all.find((observation) => observation.type === 'delivery_attempted');
  if (
    receipt?.type !== 'receipt_observed' ||
    proof?.type !== 'mint_proofs_state' ||
    delivery?.type !== 'delivery_attempted'
  ) {
    return failure(
      'ADAPTER_INVARIANT_CONFORMANCE',
      'Scenario runner did not produce required conformance evidence',
    );
  }
  return {
    ok: true,
    evidence: {
      tier: 'T1',
      requestId: receipt.requestId,
      deliveryId: receipt.deliveryId,
      payloadHash: receipt.payloadHash,
      receiptVersion: receipt.version,
      credits: creditCount,
      proofSetHash: delivery.proofSetHash,
      proofState: proofState(proof.state),
      transports,
      seed,
    },
  };
}

function failedResult(error: ScenarioError): MatrixExecutionResult {
  if (error.name === 'AdapterNotApplicableError') return { ok: null, reason: error.message };
  if (/request does not match/i.test(error.message)) {
    return failure(
      'ADAPTER_REQUEST_IDENTITY',
      'Receiver request does not match the requested payment',
    );
  }
  if (/receipt.*(scenario payment|identit)/i.test(error.message)) {
    return failure(
      'ADAPTER_RECEIPT_IDENTITY',
      'Sender or receiver receipt does not match the requested payment',
    );
  }
  if (/transition/i.test(error.message)) {
    return failure(
      'ADAPTER_RECEIPT_TRANSITION',
      'Receiver receipt is not a valid progression from the sender receipt',
    );
  }
  if (/settled state/i.test(error.message)) {
    return failure('ADAPTER_RECEIPT_NOT_SETTLED', 'Receiver did not report a settled payment');
  }
  if (/merchant credit/i.test(error.message)) {
    return failure(
      'ADAPTER_LEDGER_EVIDENCE',
      'Receiver must report exactly one matching merchant credit',
    );
  }
  if (/proof/i.test(error.message)) {
    return failure(
      'ADAPTER_PROOF_EVIDENCE',
      'Receiver must report exactly one spent input proof set',
    );
  }
  if (/oracle safety violation/i.test(error.message)) {
    return failure('ADAPTER_INVARIANT_CONFORMANCE', error.message);
  }
  if (/External sender did not return a receipt after retry attempts: /i.test(error.message)) {
    return failure(
      'ADAPTER_PAIR_EXECUTION',
      `External adapter pair execution failed during sender send${error.message.slice(
        error.message.indexOf(':'),
      )}`,
    );
  }
  return failure('ADAPTER_PAIR_EXECUTION', 'External adapter pair execution failed');
}

export async function runExternalDeliveryPair(
  input: ExternalDeliveryPairInput,
): Promise<MatrixExecutionResult> {
  if (input.profile !== DELIVERY_PROFILE) {
    return { ok: null, reason: `External pair profile ${input.profile} is not supported` };
  }

  const transports: AdapterTransport[] = [...new Set(input.transports ?? (['http'] as const))];
  if (
    transports.length < 1 ||
    transports.some((transport) => transport !== 'http' && transport !== 'nostr')
  ) {
    return failure('ADAPTER_TRANSPORT_SELECTION', 'External pair transport selection is invalid');
  }

  try {
    const runner = new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender: input.sender,
        receiver: input.receiver,
        faults: new DirectExternalFaultController(),
        amount: input.amount,
        unit: input.unit,
        transports,
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
        ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
        senderAlias: SCENARIO_SENDER,
        requestAlias: SCENARIO_REQUEST,
      }),
    );
    const result = await runner.run(
      {
        name: 'external-delivery-pair',
        commands: [{ type: 'send', sender: SCENARIO_SENDER, requestId: SCENARIO_REQUEST }],
      },
      input.seed,
    );
    return result.status === 'passed'
      ? passedEvidence(result.artifact, input.seed, transports)
      : failedResult(result.error);
  } catch {
    return failure('ADAPTER_PAIR_EXECUTION', 'External adapter pair execution failed');
  }
}
