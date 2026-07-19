import { describe, expect, it } from 'vitest';
import {
  ScenarioRunner,
  type DriverSendResult,
  type FaultRule,
  type ScenarioDriver,
  type ScenarioSpec,
} from '../src/index.js';

class FakeDriver implements ScenarioDriver {
  readonly calls: string[] = [];
  private seed = '';

  async reset(seed: string): Promise<void> {
    this.seed = seed;
    this.calls.length = 0;
    this.calls.push(`reset:${seed}`);
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return { fake: true, seed: this.seed };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    this.calls.push(`fault:${target}:${rule.kind}`);
  }

  async send(sender: string, requestId: string): Promise<DriverSendResult> {
    this.calls.push(`send:${sender}:${requestId}`);
    return {
      value: { accepted: true, secret: 'must-not-leak', token: 'cashuAsecret-token' },
      observations: [
        { type: 'request_observed', requestId, singleUse: true },
        {
          type: 'delivery_attempted',
          requestId,
          deliveryId: 'delivery-1',
          payloadHash: 'payload-a',
          proofSetHash: 'proofs-a',
          transport: 'http',
        },
        { type: 'mint_proofs_state', proofSetHash: 'proofs-a', state: 'SPENT' },
        {
          type: 'receiver_settled',
          deliveryId: 'delivery-1',
          replacementPlanHash: 'plan-a',
        },
        {
          type: 'merchant_credited',
          creditId: 'credit-a',
          requestId,
          deliveryId: 'delivery-1',
          amount: 8,
          unit: 'sat',
        },
        {
          type: 'receipt_observed',
          requestId,
          deliveryId: 'delivery-1',
          payloadHash: 'payload-a',
          status: 'settled',
          detailCode: 'settled',
          version: 2,
          amount: 8,
          unit: 'sat',
        },
      ],
    };
  }

  async restart(component: string): Promise<void> {
    this.calls.push(`restart:${component}`);
  }

  async clearFaults(target?: string): Promise<void> {
    this.calls.push(`clear:${target ?? 'all'}`);
  }
}

const scenario: ScenarioSpec = {
  name: 'http-response-loss',
  commands: [
    {
      type: 'configure_fault',
      target: 'http',
      rule: { kind: 'drop_response', occurrence: 1 },
    },
    { type: 'send', sender: 'sender-a', requestId: 'request-1' },
    { type: 'advance_time', milliseconds: 250 },
    { type: 'restart', component: 'receiver' },
    { type: 'clear_faults', target: 'http' },
    { type: 'assert_quiescent' },
  ],
};

describe('ScenarioRunner', () => {
  it('runs commands, feeds the oracle, and emits paired deterministic history', async () => {
    const driver = new FakeDriver();
    const runner = new ScenarioRunner(driver);
    const result = await runner.run(scenario, 'seed-1');

    expect(result.status).toBe('passed');
    expect(result.artifact.seed).toBe('seed-1');
    expect(result.artifact.scenario).toBe('http-response-loss');
    expect(result.artifact.history.map((event) => event.sequence)).toEqual(
      result.artifact.history.map((_event, index) => index),
    );
    expect(result.artifact.history.at(-1)?.at).toBe(250);
    expect(JSON.stringify(result.artifact)).not.toContain('must-not-leak');
    expect(JSON.stringify(result.artifact)).not.toContain('cashuAsecret-token');
    expect(driver.calls).toEqual([
      'reset:seed-1',
      'fault:http:drop_response',
      'send:sender-a:request-1',
      'restart:receiver',
      'clear:http',
    ]);

    for (const index of scenario.commands.keys()) {
      expect(
        result.artifact.history.some(
          (event) => event.commandIndex === index && event.phase === 'invoked',
        ),
      ).toBe(true);
      expect(
        result.artifact.history.some(
          (event) => event.commandIndex === index && event.phase === 'completed',
        ),
      ).toBe(true);
    }
  });

  it('turns oracle violations into reproducible failure artifacts', async () => {
    const driver = new FakeDriver();
    const original = driver.send.bind(driver);
    driver.send = async (sender, requestId) => {
      const result = await original(sender, requestId);
      return {
        ...result,
        observations: [
          ...result.observations,
          {
            type: 'merchant_credited',
            creditId: 'credit-b',
            requestId,
            deliveryId: 'delivery-1',
            amount: 8,
            unit: 'sat',
          },
        ],
      };
    };

    const result = await new ScenarioRunner(driver).run(scenario, 'seed-fail');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected failed scenario');
    expect(result.error.message).toMatch(/one credit/i);
    expect(result.artifact.history.at(-1)).toMatchObject({
      phase: 'completed',
      outcome: 'failed',
    });
  });

  it('rejects secret-bearing scenario commands before creating artifacts', async () => {
    const driver = new FakeDriver();
    const unsafe = {
      name: 'unsafe-fixture',
      commands: [
        {
          type: 'configure_fault',
          target: 'http',
          rule: { kind: 'replace_body', secret: 'spend-secret' },
        },
      ],
    } as unknown as ScenarioSpec;

    await expect(new ScenarioRunner(driver).run(unsafe, 'seed-unsafe')).rejects.toThrowError(
      /sensitive/i,
    );
    expect(driver.calls).toEqual([]);
  });
});
