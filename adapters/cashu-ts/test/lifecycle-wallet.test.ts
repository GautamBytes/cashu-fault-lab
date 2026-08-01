import type { LifecycleOperationInput } from '@cashu-fault-lab/wallet-lifecycle-contract';
import { describe, expect, test } from 'vitest';
import {
  CashuTsLifecycleOperations,
  MemoryCashuTsLifecycleStore,
} from '../src/lifecycle/operations.js';
import { CashuTsLifecycleWallet, type CashuTsLifecycleClient } from '../src/lifecycle/wallet.js';

const mint = 'http://127.0.0.1:3338';
const mintInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'mint',
  mint,
  unit: 'sat',
  amount: 8,
  method: 'bolt11',
};

class MintClient implements CashuTsLifecycleClient {
  readonly calls: string[] = [];
  failCompleteOnce = false;

  async loadMint(): Promise<void> {
    this.calls.push('loadMint');
  }

  async createMintQuoteBolt11(amount: number): Promise<unknown> {
    this.calls.push(`quote:${amount}`);
    return { quote: 'secret-mint-quote-id', request: 'lnbc-secret-invoice', state: 'PAID' };
  }

  async checkMintQuoteBolt11(quote: unknown): Promise<unknown> {
    this.calls.push('checkQuote');
    return quote;
  }

  async prepareMint(
    method: string,
    amount: number,
    quote: unknown,
    _config: unknown,
    outputType: unknown,
  ): Promise<unknown> {
    this.calls.push(`prepareMint:${method}:${amount}`);
    return { method, amount, quote, outputType, payload: { quote: 'secret-mint-quote-id' } };
  }

  async completeMint(preview: unknown): Promise<readonly unknown[]> {
    this.calls.push(`completeMint:${JSON.stringify(preview)}`);
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      throw new Error('mint committed and response was lost');
    }
    return [
      {
        amount: 8,
        id: '00aa',
        secret: 'minted-proof-secret',
        C: `02${'11'.repeat(32)}`,
      },
    ];
  }
}

function harness(client: MintClient, store = new MemoryCashuTsLifecycleStore()) {
  const wallet = new CashuTsLifecycleWallet({
    mintUrl: mint,
    unit: 'sat',
    store,
    walletFactory: () => client,
    sleep: async () => {},
  });
  const operations = new CashuTsLifecycleOperations({
    store,
    wallet,
    mint,
    unit: 'sat',
  });
  return { operations, store };
}

describe('CashuTsLifecycleWallet mint', () => {
  test('persists prepared mint material and minted proofs', async () => {
    const client = new MintClient();
    const { operations, store } = harness(client);
    await operations.reset('mint-wallet-seed');

    await expect(operations.start(mintInput)).resolves.toMatchObject({
      kind: 'mint',
      phase: 'succeeded',
      amount: 8,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      outputPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
      proofs: [{ proofId: expect.stringMatching(/^[a-f0-9]{64}$/u), state: 'UNSPENT' }],
    });
    expect(JSON.stringify(await operations.wallet())).not.toContain('minted-proof-secret');
    expect((await store.listProofs(mint, 'sat'))[0]).toMatchObject({
      material: { secret: 'minted-proof-secret' },
    });
    expect(client.calls.map((call) => call.split(':')[0])).toEqual([
      'loadMint',
      'quote',
      'prepareMint',
      'completeMint',
    ]);
  });

  test('replays the same prepared mint after the first response is lost', async () => {
    const client = new MintClient();
    client.failCompleteOnce = true;
    const { operations, store } = harness(client);
    await operations.reset('mint-replay-seed');

    await expect(operations.start(mintInput)).rejects.toThrow(
      'mint committed and response was lost',
    );
    const submitted = await store.get(mintInput.operationId);
    expect(submitted).toMatchObject({ view: { phase: 'submitted' }, prepared: expect.any(Object) });

    const replacement = harness(client, store).operations;
    await expect(replacement.resume(mintInput.operationId)).resolves.toMatchObject({
      phase: 'succeeded',
      amount: 8,
    });
    const completeCalls = client.calls.filter((call) => call.startsWith('completeMint:'));
    expect(completeCalls).toHaveLength(2);
    expect(completeCalls[1]).toBe(completeCalls[0]);
    await expect(replacement.wallet()).resolves.toMatchObject({
      balances: { available: 8 },
    });
  });
});
