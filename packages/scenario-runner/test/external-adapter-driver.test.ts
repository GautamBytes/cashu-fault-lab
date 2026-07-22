import {
  type AdapterCapabilities,
  type AdapterClient,
  type CreateRequestInput,
  type DeliveryReceiptView,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
  type SendPaymentInput,
} from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import {
  ExternalAdapterScenarioDriver,
  type ExternalFaultController,
} from '../src/external-adapter-driver.js';
import { ScenarioRunner, type FaultRule, type ScenarioSpec } from '../src/runner.js';

const requestId = 'AAECAwQFBgcICQoLDA0ODw';

function capability(id: string, role: 'sender' | 'receiver'): AdapterCapabilities {
  return {
    implementation: id,
    version: '1.0.0',
    nuts: [3, 7, 18],
    transports: ['http'],
    evidenceTier: 'T1',
    encodings: ['creqA'],
    profiles: [{ name: 'delivery-v1', roles: [role], status: 'supported' }],
  };
}

class Faults implements ExternalFaultController {
  readonly applied: Array<{ target: string; rule: FaultRule }> = [];
  readonly restarts: string[] = [];
  forwards = 1;
  inbound = 1;
  onRestart: ((component: string) => void) | undefined;

  async reset(): Promise<void> {
    this.applied.splice(0);
    this.restarts.splice(0);
    this.forwards = 1;
    this.inbound = 1;
  }

  async configure(target: string, rule: FaultRule): Promise<void> {
    this.applied.push({ target, rule });
    if (rule.kind === 'duplicate') this.forwards = 1 + (rule.duplicateCount ?? 1);
    if (rule.kind === 'drop_response') {
      this.inbound = 2;
      this.forwards = 2;
    }
  }

  async clear(): Promise<void> {}

  async evidence(): Promise<{ readonly inbound: number; readonly forwarded: number }> {
    return { inbound: this.inbound, forwarded: this.forwards };
  }

  async restart(component: string): Promise<void> {
    this.restarts.push(component);
    this.onRestart?.(component);
  }
}

class Receiver implements AdapterClient {
  deliveryId = '';
  capabilityFailures = 0;
  readonly request: PaymentRequestView = {
    id: requestId,
    raw: 'creqAexternal',
    amount: 8,
    unit: 'sat',
    singleUse: true,
    expiresAt: 1_784_400_300,
    transports: [{ type: 'post', target: 'http://127.0.0.1:8181/pay' }],
  };

  async capabilities(): Promise<AdapterCapabilities> {
    if (this.capabilityFailures > 0) {
      this.capabilityFailures -= 1;
      throw new Error('receiver is still restarting');
    }
    return capability('receiver-wallet', 'receiver');
  }

  async reset(): Promise<void> {}

  async createRequest(_input: CreateRequestInput): Promise<PaymentRequestView> {
    return this.request;
  }

  async send(_input: SendPaymentInput): Promise<DeliveryReceiptView> {
    throw new Error('Receiver cannot send');
  }

  receipt(): DeliveryReceiptView {
    return {
      profile: 'cashu-delivery-v1',
      request_id: requestId,
      delivery_id: this.deliveryId,
      payload_hash: 'a'.repeat(64),
      status: 'settled',
      status_version: 2,
      mint: 'https://mint.example',
      unit: 'sat',
      amount: 8,
      detail_code: 'settled',
    };
  }

  async delivery(): Promise<DeliveryReceiptView> {
    return this.receipt();
  }

  async ledger(): Promise<readonly LedgerCreditView[]> {
    return [
      {
        requestId,
        deliveryId: this.deliveryId,
        amount: 8,
        unit: 'sat',
        creditCount: 1,
        createdAt: 1_784_399_401,
      },
    ];
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    return [
      {
        deliveryId: this.deliveryId,
        proofSetHash: 'b'.repeat(64),
        inputYs: [`02${'01'.repeat(32)}`],
        state: 'spent',
      },
    ];
  }
}

class Sender implements AdapterClient {
  calls = 0;
  failures = 0;
  readonly deliveryIds: string[] = [];

  constructor(private readonly receiver: Receiver) {}

  async capabilities(): Promise<AdapterCapabilities> {
    return capability('sender-wallet', 'sender');
  }

  async reset(): Promise<void> {
    this.calls = 0;
    this.deliveryIds.splice(0);
  }

  async createRequest(_input: CreateRequestInput): Promise<PaymentRequestView> {
    throw new Error('Sender cannot create requests');
  }

  async send(input: SendPaymentInput): Promise<DeliveryReceiptView> {
    this.calls += 1;
    this.receiver.deliveryId = input.deliveryId ?? '';
    this.deliveryIds.push(this.receiver.deliveryId);
    if (this.calls <= this.failures) throw new Error('response disappeared');
    return this.receiver.receipt();
  }

  async delivery(): Promise<DeliveryReceiptView> {
    return this.receiver.receipt();
  }

  async ledger(): Promise<readonly LedgerCreditView[]> {
    return [];
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    return [];
  }
}

function scenario(kind: 'drop_response' | 'duplicate', duplicateCount?: number): ScenarioSpec {
  return {
    name: `external-${kind}`,
    commands: [
      {
        type: 'configure_fault',
        target: 'http',
        rule: {
          kind,
          occurrence: 1,
          ...(duplicateCount === undefined ? {} : { duplicateCount }),
        },
      },
      { type: 'send', sender: 'sender-wallet', requestId },
      { type: 'assert_quiescent' },
    ],
  };
}

describe('ExternalAdapterScenarioDriver', () => {
  it('reuses one logical delivery after a lost response and produces one credit', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    sender.failures = 1;
    const faults = new Faults();
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({ sender, receiver, faults, amount: 8, unit: 'sat' }),
    ).run(scenario('drop_response'), 'external-seed');

    expect(result.status).toBe('passed');
    expect(sender.calls).toBe(2);
    expect(new Set(sender.deliveryIds).size).toBe(1);
    expect((await receiver.ledger())[0]).toMatchObject({ creditCount: 1 });
    expect(faults.applied).toContainEqual({
      target: 'http',
      rule: { kind: 'drop_response', occurrence: 1 },
    });
    const attempts = result.artifact.history.filter(
      (event) => event.phase === 'observation' && event.event === 'delivery_attempted',
    );
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => JSON.stringify(attempt.data))).size).toBe(1);
  });

  it('backs off deterministically between transient delivery failures', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    sender.failures = 2;
    const waits: number[] = [];
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new Faults(),
        amount: 8,
        unit: 'sat',
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
    ).run(scenario('drop_response'), 'external-backoff');

    expect(result.status).toBe('passed');
    expect(sender.calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it('records gateway duplicates as one delivery and one merchant credit', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    const driver = new ExternalAdapterScenarioDriver({
      sender,
      receiver,
      faults,
      amount: 8,
      unit: 'sat',
    });
    const result = await new ScenarioRunner(driver).run(
      scenario('duplicate', 3),
      'external-duplicate',
    );

    expect(result.status).toBe('passed');
    const observations = result.artifact.history.filter((event) => event.phase === 'observation');
    expect(observations.filter((event) => event.event === 'delivery_attempted')).toHaveLength(4);
    expect(observations.filter((event) => event.event === 'redemption_started')).toHaveLength(1);
    expect(observations.filter((event) => event.event === 'merchant_credited')).toHaveLength(1);
  });

  it('reports one redemption transition across repeated send commands for the same delivery', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new Faults(),
        amount: 8,
        unit: 'sat',
      }),
    ).run(
      {
        name: 'external-repeat-send',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'assert_quiescent' },
        ],
      },
      'external-repeat',
    );

    expect(result.status).toBe('passed');
    const observations = result.artifact.history.filter((event) => event.phase === 'observation');
    expect(observations.filter((event) => event.event === 'delivery_attempted')).toHaveLength(2);
    expect(observations.filter((event) => event.event === 'redemption_started')).toHaveLength(1);
    expect(observations.filter((event) => event.event === 'merchant_credited')).toHaveLength(2);
  });

  it('waits for a restarted receiver adapter to become ready before the next command', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    const waits: number[] = [];
    faults.onRestart = (component) => {
      if (component === 'receiver') receiver.capabilityFailures = 2;
    };
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults,
        amount: 8,
        unit: 'sat',
        restartReadinessDelayMs: 25,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
    ).run(
      {
        name: 'external-restart-readiness',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'restart', component: 'receiver' },
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'assert_quiescent' },
        ],
      },
      'external-restart-readiness',
    );

    expect(result.status).toBe('passed');
    expect(faults.restarts).toEqual(['receiver']);
    expect(waits).toEqual([25, 25]);
  });
});
