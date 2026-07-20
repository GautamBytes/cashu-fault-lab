import { Amount, MintQuoteState, type MintQuoteBolt11Response, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { FundedCashuTsWallet, type CashuTsWalletClient } from '../src/funded-wallet.js';

const proof: Proof = {
  amount: Amount.from(8),
  id: '00aa',
  secret: 'wallet-proof-secret',
  C: `02${'11'.repeat(32)}`,
};

class Client implements CashuTsWalletClient {
  loadCalls = 0;
  quoteCalls = 0;
  mintCalls = 0;
  mintOutputType: unknown;
  sendCalls = 0;
  sendOutputConfig: unknown;

  async loadMint(): Promise<void> {
    this.loadCalls += 1;
  }

  async createMintQuoteBolt11(): Promise<MintQuoteBolt11Response> {
    this.quoteCalls += 1;
    return {
      quote: 'quote-id',
      request: 'lnbc-test',
      unit: 'sat',
      amount: Amount.from(8),
      state: MintQuoteState.PAID,
      expiry: null,
    };
  }

  async checkMintQuoteBolt11(
    quote: string | MintQuoteBolt11Response,
  ): Promise<MintQuoteBolt11Response> {
    return typeof quote === 'string' ? this.createMintQuoteBolt11() : quote;
  }

  async mintProofsBolt11(
    _amount?: unknown,
    _quote?: unknown,
    _config?: unknown,
    outputType?: unknown,
  ): Promise<Proof[]> {
    this.mintCalls += 1;
    this.mintOutputType = outputType;
    return [proof];
  }

  async send(
    _amount?: unknown,
    _proofs?: unknown,
    _config?: unknown,
    outputConfig?: unknown,
  ): Promise<{ readonly keep: Proof[]; readonly send: Proof[] }> {
    this.sendCalls += 1;
    this.sendOutputConfig = outputConfig;
    return { keep: [], send: [proof] };
  }
}

describe('FundedCashuTsWallet', () => {
  it('funds on reset, reserves once per delivery, and exposes only hashed evidence', async () => {
    const client = new Client();
    const wallet = new FundedCashuTsWallet({
      mintUrl: 'https://mint.example',
      fundingAmount: 8,
      walletFactory: () => client,
      sleep: async () => {},
    });

    await wallet.reset('wallet-seed');
    const first = await wallet.reserve(
      8,
      'sat',
      ['https://mint.example'],
      'EBESExQVFhcYGRobHB0eHw',
    );
    const second = await wallet.reserve(
      8,
      'sat',
      ['https://mint.example'],
      'EBESExQVFhcYGRobHB0eHw',
    );

    expect(first).toEqual(second);
    expect(client.loadCalls).toBe(1);
    expect(client.quoteCalls).toBe(1);
    expect(client.mintCalls).toBe(1);
    expect(client.mintOutputType).toEqual({ type: 'random' });
    expect(client.sendCalls).toBe(1);
    expect(client.sendOutputConfig).toEqual({
      send: { type: 'random' },
      keep: { type: 'random' },
    });
    const pending = await wallet.evidence('EBESExQVFhcYGRobHB0eHw');
    expect(pending).toMatchObject({
      state: 'pending',
      proofSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(pending)).not.toContain(proof.secret);

    await wallet.markSettled('EBESExQVFhcYGRobHB0eHw');
    await expect(wallet.evidence('EBESExQVFhcYGRobHB0eHw')).resolves.toMatchObject({
      state: 'spent',
    });
  });
});
