import {
  AdapterClientError,
  developmentIdentity,
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
  type ExternalFaultRoute,
  type ExternalFaultRuleHandle,
} from '../src/external-adapter-driver.js';
import { ScenarioRunner, type FaultRule, type ScenarioSpec } from '../src/runner.js';

const requestId = 'AAECAwQFBgcICQoLDA0ODw';

function capability(id: string, role: 'sender' | 'receiver'): AdapterCapabilities {
  return {
    schemaVersion: 2,
    implementation: developmentIdentity({
      id,
      version: '1.0.0',
      language: 'typescript',
      runtime: 'node-24',
    }),
    roles: {
      [role]: {
        transports: ['http'],
        profiles: ['delivery-v1'],
        durability: 'persistent',
        evidence: { tier: 'T1', sources: ['adapter', 'runner', 'transport'] },
      },
    },
    nuts: [3, 7, 18],
    encodings: ['creqA'],
    mints: [],
  };
}

class Faults implements ExternalFaultController {
  readonly applied: Array<{
    target: string;
    rule: FaultRule;
    route?: ExternalFaultRoute;
    handle: ExternalFaultRuleHandle;
  }> = [];
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

  async configure(
    target: string,
    rule: FaultRule,
    route?: ExternalFaultRoute,
  ): Promise<ExternalFaultRuleHandle> {
    if (route === undefined) throw new Error('route required');
    const handle = {
      id: `rule-${this.applied.length + 1}`,
      target,
      phase: rule.kind === 'drop_response' ? 'after_downstream_response' : 'before_forward',
      action: rule.kind === 'duplicate' ? 'duplicate' : 'drop',
      method: route.method,
      path: route.path,
    };
    this.applied.push({ target, rule, route, handle });
    if (rule.kind === 'duplicate') this.forwards = 1 + (rule.duplicateCount ?? 1);
    if (rule.kind === 'drop_response') {
      this.inbound = 2;
      this.forwards = 2;
    }
    return handle;
  }

  async clear(): Promise<void> {}

  async evidence(): Promise<{
    readonly inbound: number;
    readonly forwarded: number;
    readonly controller: 'http-gateway';
    readonly observedTarget: 'http';
    readonly rules: readonly (ExternalFaultRuleHandle & { readonly applied: number })[];
  }> {
    return {
      inbound: this.inbound,
      forwarded: this.forwards,
      controller: 'http-gateway',
      observedTarget: 'http',
      rules: this.applied.map(({ handle }) => ({ ...handle, applied: 1 })),
    };
  }

  async restart(component: string): Promise<void> {
    this.restarts.push(component);
    this.onRestart?.(component);
  }
}

class ZeroTrafficFaults extends Faults {
  async reset(): Promise<void> {
    await super.reset();
    this.inbound = 0;
    this.forwards = 0;
  }

  async configure(
    target: string,
    rule: FaultRule,
    route?: ExternalFaultRoute,
  ): Promise<ExternalFaultRuleHandle> {
    const handle = await super.configure(target, rule, route);
    this.inbound = 0;
    this.forwards = 0;
    return handle;
  }
}

class UnappliedGatewayFaults extends Faults {
  async evidence(): Promise<{
    readonly inbound: number;
    readonly forwarded: number;
    readonly controller: 'http-gateway';
    readonly observedTarget: 'http';
    readonly rules: readonly (ExternalFaultRuleHandle & { readonly applied: 0 })[];
  }> {
    return {
      inbound: 2,
      forwarded: 2,
      controller: 'http-gateway',
      observedTarget: 'http',
      rules: this.applied.map(({ handle }) => ({ ...handle, applied: 0 as const })),
    };
  }
}

class UnrelatedAppliedGatewayFaults extends Faults {
  async evidence() {
    const configured = this.applied[0]!.handle;
    return {
      inbound: 2,
      forwarded: 2,
      controller: 'http-gateway' as const,
      observedTarget: 'http' as const,
      rules: [
        { ...configured, applied: 0 },
        {
          ...configured,
          id: 'unrelated-rule',
          path: '/unrelated',
          applied: 1,
        },
      ],
    };
  }
}

class Receiver implements AdapterClient {
  deliveryId = '';
  capabilityFailures = 0;
  deliveryFailures = 0;
  readonly createRequestInputs: CreateRequestInput[] = [];
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
      throw new AdapterClientError('ADAPTER_UNAVAILABLE', 'Adapter request failed');
    }
    return capability('receiver-wallet', 'receiver');
  }

  async reset(): Promise<void> {}

  async createRequest(input: CreateRequestInput): Promise<PaymentRequestView> {
    this.createRequestInputs.push(input);
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
    if (this.deliveryFailures > 0) {
      this.deliveryFailures -= 1;
      throw new AdapterClientError('ADAPTER_HTTP_STATUS', 'Adapter returned HTTP status 503');
    }
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
  availabilityFailures = 0;
  readonly deliveryIds: string[] = [];

  constructor(private readonly receiver: Receiver) {}

  async capabilities(): Promise<AdapterCapabilities> {
    if (this.availabilityFailures > 0) {
      this.availabilityFailures -= 1;
      throw new AdapterClientError('ADAPTER_UNAVAILABLE', 'Adapter request failed');
    }
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
    if (this.availabilityFailures > 0) {
      this.availabilityFailures -= 1;
      throw new AdapterClientError('ADAPTER_UNAVAILABLE', 'Adapter request failed');
    }
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
  it('uses runner-observed attempts when an unused gateway reports zero traffic', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new ZeroTrafficFaults(),
        amount: 8,
        unit: 'sat',
      }),
    ).run(
      {
        name: 'external-no-fault',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'assert_quiescent' },
        ],
      },
      'external-no-fault',
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        name: 'InvariantEvaluationError',
        message: expect.stringContaining('at-most-once-redemption-start'),
      },
    });
    expect(
      result.artifact.history.filter(
        (event) => event.phase === 'observation' && event.event === 'delivery_attempted',
      ),
    ).toHaveLength(1);
  });

  it('fails explicitly when a configured gateway fault receives no traffic', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new ZeroTrafficFaults(),
        amount: 8,
        unit: 'sat',
      }),
    ).run(scenario('drop_response'), 'external-unexercised-fault');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected configured fault to fail');
    expect(result.error.message).toBe('External configured fault was not exercised');
  });

  it('passes the configured HTTP gateway target to receiver request creation', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const options = {
      sender,
      receiver,
      faults: new ZeroTrafficFaults(),
      amount: 8,
      unit: 'sat',
      httpTarget: 'http://127.0.0.1:4300',
    };

    await new ScenarioRunner(new ExternalAdapterScenarioDriver(options)).run(
      {
        name: 'external-gateway-target',
        commands: [{ type: 'assert_quiescent' }],
      },
      'external-gateway-target',
    );

    expect(receiver.createRequestInputs).toEqual([
      expect.objectContaining({
        transports: ['http'],
        httpTarget: 'http://127.0.0.1:4300',
      }),
    ]);
  });

  it('fails explicitly when gateway traffic did not apply the configured fault rule', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new UnappliedGatewayFaults(),
        amount: 8,
        unit: 'sat',
      }),
    ).run(scenario('drop_response'), 'external-unapplied-fault');

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected unapplied fault to fail');
    expect(result.error.message).toBe('External configured fault was not exercised');
  });

  it('does not accept an unrelated applied rule as configured fault evidence', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new UnrelatedAppliedGatewayFaults(),
        amount: 8,
        unit: 'sat',
      }),
    ).run(scenario('drop_response'), 'external-unrelated-fault');

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: 'External configured fault was not exercised' },
    });
  });

  it('reuses one logical delivery after a lost response and produces one credit', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    sender.failures = 1;
    const faults = new Faults();
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({ sender, receiver, faults, amount: 8, unit: 'sat' }),
    ).run(scenario('drop_response'), 'external-seed');

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
    expect(sender.calls).toBe(2);
    expect(new Set(sender.deliveryIds).size).toBe(1);
    expect((await receiver.ledger())[0]).toMatchObject({ creditCount: 1 });
    expect(faults.applied).toContainEqual({
      target: 'http',
      rule: { kind: 'drop_response', occurrence: 1 },
      route: { method: 'POST', path: '/pay' },
      handle: {
        id: 'rule-1',
        target: 'http',
        phase: 'after_downstream_response',
        action: 'drop',
        method: 'POST',
        path: '/pay',
      },
    });
    const attempts = result.artifact.history.filter(
      (event) => event.phase === 'observation' && event.event === 'delivery_attempted',
    );
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => JSON.stringify(attempt.data))).size).toBe(1);
    expect(
      result.artifact.invariants.find(
        (item) => item.id === 'at-most-one-merchant-credit-per-delivery',
      ),
    ).toMatchObject({ status: 'passed', confidence: 'adapter_claimed' });
    expect(
      result.artifact.invariants.find((item) => item.id === 'at-most-once-redemption-start'),
    ).toMatchObject({ status: 'not_observable' });
  });

  it('qualifies mint and ledger observations only through independent authorities', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    sender.failures = 1;
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new Faults(),
        evidence: {
          ledger: { ledger: () => receiver.ledger() },
          mint: {
            proofs: () => receiver.proofs(),
            redemptions: async () => [
              {
                deliveryId: receiver.deliveryId,
                proofSetHash: 'b'.repeat(64),
                starts: 1,
              },
            ],
          },
        },
        amount: 8,
        unit: 'sat',
      }),
    ).run(scenario('drop_response'), 'external-independent-evidence');

    expect(
      result.artifact.invariants.find((item) => item.id === 'independent-ledger-evidence'),
    ).toMatchObject({ status: 'passed', confidence: 'observed' });
    expect(
      result.artifact.invariants.find((item) => item.id === 'independent-mint-evidence'),
    ).toMatchObject({ status: 'passed', confidence: 'observed' });
    expect(
      result.artifact.invariants.find((item) => item.id === 'at-most-once-redemption-start'),
    ).toMatchObject({ status: 'passed', confidence: 'observed' });
    expect(
      result.artifact.invariants.find((item) => item.id === 'retry-convergence'),
    ).toMatchObject({ status: 'passed', confidence: 'derived' });
  });

  it('fails when independent mint evidence reports duplicate redemption starts', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults: new Faults(),
        evidence: {
          mint: {
            proofs: () => receiver.proofs(),
            redemptions: async () => [
              {
                deliveryId: receiver.deliveryId,
                proofSetHash: 'b'.repeat(64),
                starts: 2,
              },
            ],
          },
        },
        amount: 8,
        unit: 'sat',
      }),
    ).run(scenario('drop_response'), 'external-duplicate-redemption');

    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/redemption .* at most once/i) },
    });
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

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
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

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
    const observations = result.artifact.history.filter((event) => event.phase === 'observation');
    expect(observations.filter((event) => event.event === 'delivery_attempted')).toHaveLength(4);
    expect(observations.filter((event) => event.event === 'redemption_started')).toHaveLength(0);
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
        evidence: {
          mint: {
            proofs: () => receiver.proofs(),
            redemptions: async () => [
              {
                deliveryId: receiver.deliveryId,
                proofSetHash: 'b'.repeat(64),
                starts: 1,
              },
            ],
          },
        },
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
    expect(observations.filter((event) => event.event === 'merchant_credited')).toHaveLength(1);
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

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
    expect(faults.restarts).toEqual(['receiver']);
    expect(waits).toEqual([25, 25]);
  });

  it('waits for a restarted receiver adapter to restore settled delivery state', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    const waits: number[] = [];
    faults.onRestart = (component) => {
      if (component === 'receiver') receiver.deliveryFailures = 2;
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
        name: 'external-restart-durable-state',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'restart', component: 'receiver' },
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'assert_quiescent' },
        ],
      },
      'external-restart-durable-state',
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
    expect(faults.restarts).toEqual(['receiver']);
    expect(waits).toEqual([25, 25]);
  });

  it('waits for the sender when a receiver restart disrupts the adapter pair', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    const waits: number[] = [];
    faults.onRestart = (component) => {
      if (component === 'receiver') sender.availabilityFailures = 3;
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
        name: 'external-restart-pair-readiness',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'restart', component: 'receiver' },
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'assert_quiescent' },
        ],
      },
      'external-restart-pair-readiness',
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
    expect(faults.restarts).toEqual(['receiver']);
    expect(waits).toEqual([25, 25, 25]);
  });

  it('allows repeated container restart backoff to exceed twenty readiness probes', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    const waits: number[] = [];
    faults.onRestart = (component) => {
      if (component === 'receiver') sender.availabilityFailures = 20;
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
        name: 'external-repeated-container-restart-backoff',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'restart', component: 'receiver' },
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'assert_quiescent' },
        ],
      },
      'external-repeated-container-restart-backoff',
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'InvariantEvaluationError' },
    });
    expect(faults.restarts).toEqual(['receiver']);
    expect(waits).toHaveLength(20);
  });

  it('reports the exact sender readiness probe failure after exhausting restart attempts', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    faults.onRestart = (component) => {
      if (component === 'receiver') sender.availabilityFailures = 2;
    };
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults,
        amount: 8,
        unit: 'sat',
        restartReadinessAttempts: 2,
        sleep: async () => {},
      }),
    ).run(
      {
        name: 'external-restart-sender-diagnostics',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'restart', component: 'receiver' },
        ],
      },
      'external-restart-sender-diagnostics',
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected restart readiness to fail');
    expect(result.error.message).toBe(
      'External receiver restart readiness failed after 2 attempts: External adapter sender capability discovery failed: ADAPTER_UNAVAILABLE Adapter request failed',
    );
  });

  it('reports the exact receiver delivery probe failure after exhausting restart attempts', async () => {
    const receiver = new Receiver();
    const sender = new Sender(receiver);
    const faults = new Faults();
    faults.onRestart = (component) => {
      if (component === 'receiver') receiver.deliveryFailures = 2;
    };
    const result = await new ScenarioRunner(
      new ExternalAdapterScenarioDriver({
        sender,
        receiver,
        faults,
        amount: 8,
        unit: 'sat',
        restartReadinessAttempts: 2,
        sleep: async () => {},
      }),
    ).run(
      {
        name: 'external-restart-delivery-diagnostics',
        commands: [
          { type: 'send', sender: 'sender-wallet', requestId },
          { type: 'restart', component: 'receiver' },
        ],
      },
      'external-restart-delivery-diagnostics',
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected restart readiness to fail');
    expect(result.error.message).toBe(
      'External receiver restart readiness failed after 2 attempts: External adapter receiver delivery lookup failed: ADAPTER_HTTP_STATUS Adapter returned HTTP status 503',
    );
  });
});
