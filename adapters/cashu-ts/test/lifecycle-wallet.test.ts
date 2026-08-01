import type { LifecycleOperationInput } from '@cashu-fault-lab/wallet-lifecycle-contract';
import { createHash } from 'node:crypto';
import { hashToCurve, JSONInt } from '@cashu/cashu-ts';
import { describe, expect, test, vi } from 'vitest';
import {
  CashuTsLifecycleOperations,
  MemoryCashuTsLifecycleStore,
} from '../src/lifecycle/operations.js';
import {
  assertCashuTsRestoreResponsePair,
  CashuTsLifecycleWallet,
  createCashuTsNoRedirectRequest,
  withCashuTsLifecycleOperation,
  type CashuTsLifecycleClient,
} from '../src/lifecycle/wallet.js';

const mint = 'http://127.0.0.1:3338';
const mintInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'mint',
  mint,
  unit: 'sat',
  amount: 8,
  method: 'bolt11',
};
const swapInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAAAQ',
  kind: 'swap',
  mint,
  unit: 'sat',
  amount: 4,
};
const sendInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAABA',
  kind: 'send',
  mint,
  unit: 'sat',
  amount: 4,
  recipient: 'bob',
};
const receiveInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAABQ',
  kind: 'receive',
  mint,
  unit: 'sat',
  token: 'cashuB-receive-secret-token',
};
const meltInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAACA',
  kind: 'melt',
  mint,
  unit: 'sat',
  invoice: 'lnbc-melt-secret-invoice',
  preferAsync: true,
};
const restoreInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAACQ',
  kind: 'restore',
  mint,
  unit: 'sat',
};
const reconcileInput: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAADA',
  kind: 'reconcile',
  mint,
  unit: 'sat',
  targetOperationId: meltInput.operationId,
};

class MintClient implements CashuTsLifecycleClient {
  readonly calls: string[] = [];
  readonly counters: number[] = [];
  readonly keysetId = '00aa';
  failCompleteOnce = false;

  async loadMint(): Promise<void> {
    this.calls.push('loadMint');
  }

  async createMintQuoteBolt11(amount: number): Promise<unknown> {
    this.calls.push(`quote:${amount}`);
    return {
      quote: 'secret-mint-quote-id',
      request: 'lnbc-secret-invoice',
      state: 'PAID',
      amount,
      unit: 'sat',
    };
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
    this.counters.push(Reflect.get(outputType as object, 'counter') as number);
    return {
      method,
      amount,
      quote,
      outputType,
      outputData: [{ blindedMessage: { amount: 8, id: '00aa', B_: 'mint-output' } }],
      payload: { quote: 'secret-mint-quote-id' },
    };
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
        dleq: { e: 'dleq-e', s: 'dleq-s', r: 'dleq-r' },
        p2pk_e: 'ephemeral-key-must-not-cross-the-wire',
      },
    ];
  }

  async prepareSwapToSend(
    amount: number,
    proofs: readonly unknown[],
    config: unknown,
    outputConfig: unknown,
  ): Promise<unknown> {
    this.calls.push(`prepareSwap:${amount}:${proofs.length}`);
    expect(config).toEqual({ includeFees: true });
    expect(outputConfig).toMatchObject({
      send: { type: 'deterministic', counter: expect.any(Number) },
      keep: { type: 'deterministic', counter: expect.any(Number) },
    });
    this.counters.push(
      Reflect.get(Reflect.get(outputConfig as object, 'send') as object, 'counter') as number,
      Reflect.get(Reflect.get(outputConfig as object, 'keep') as object, 'counter') as number,
    );
    return {
      amount,
      fees: 0,
      inputs: proofs,
      sendOutputs: [{ blindedMessage: { amount: 4, id: '00aa', B_: 'swap-send' } }],
      keepOutputs: [{ blindedMessage: { amount: 4, id: '00aa', B_: 'swap-keep' } }],
      keysetId: '00aa',
    };
  }

  async completeSwap(_preview?: unknown): Promise<{
    readonly keep: readonly unknown[];
    readonly send: readonly unknown[];
  }> {
    this.calls.push('completeSwap');
    return {
      keep: [{ amount: 4, id: '00aa', secret: 'swap-keep-secret', C: `02${'22'.repeat(32)}` }],
      send: [{ amount: 4, id: '00aa', secret: 'swap-send-secret', C: `02${'33'.repeat(32)}` }],
    };
  }

  async prepareSwapToReceive(
    token: string,
    _config: unknown,
    outputType: unknown,
  ): Promise<unknown> {
    this.calls.push(`prepareReceive:${token}`);
    expect(outputType).toMatchObject({ type: 'deterministic', counter: expect.any(Number) });
    this.counters.push(Reflect.get(outputType as object, 'counter') as number);
    return {
      amount: 8,
      fees: 0,
      inputs: [
        { amount: 8, id: '00aa', secret: 'receive-input-secret', C: `02${'44'.repeat(32)}` },
      ],
      keepOutputs: [{ blindedMessage: { amount: 8, id: '00aa', B_: 'receive-output' } }],
      keysetId: '00aa',
    };
  }

  async createMeltQuoteBolt11(invoice: string): Promise<unknown> {
    this.calls.push(`meltQuote:${invoice}`);
    return {
      quote: 'secret-melt-quote-id',
      request: invoice,
      unit: 'sat',
      amount: 6,
      fee_reserve: 2,
      state: 'UNPAID',
      payment_preimage: null,
    };
  }

  getFeesForProofs(): unknown {
    return 0;
  }

  async prepareMelt(
    method: string,
    quote: unknown,
    proofs: readonly unknown[],
    config: unknown,
    outputType: unknown,
  ): Promise<unknown> {
    this.calls.push(`prepareMelt:${method}:${proofs.length}`);
    expect(config).toEqual({ nut08Change: true });
    expect(outputType).toMatchObject({ type: 'deterministic', counter: expect.any(Number) });
    this.counters.push(Reflect.get(outputType as object, 'counter') as number);
    return {
      method,
      quote,
      inputs: proofs,
      outputData: [{ blindedMessage: { amount: 0, id: '00aa', B_: 'melt-change-output' } }],
      keysetId: '00aa',
    };
  }

  async completeMelt(): Promise<unknown> {
    this.calls.push('completeMelt');
    return {
      quote: {
        quote: 'secret-melt-quote-id',
        request: meltInput.kind === 'melt' ? meltInput.invoice : '',
        unit: 'sat',
        amount: 6,
        fee_reserve: 2,
        state: 'PAID',
        payment_preimage: 'never-expose-melt-preimage',
      },
      change: [{ amount: 1, id: '00aa', secret: 'melt-change-secret', C: `02${'66'.repeat(32)}` }],
      outputData: [],
    };
  }

  async restore(start: number, count: number, config: unknown): Promise<unknown> {
    this.calls.push(`restore:${start}:${count}`);
    expect(config).toEqual({ keysetId: '00aa' });
    return {
      proofs: [
        { amount: 8, id: '00aa', secret: 'restored-proof-secret', C: `02${'77'.repeat(32)}` },
      ],
      lastCounterWithSignature: 7,
    };
  }

  async prepareRestoreOutputs(
    start: number,
    count: number,
    keysetId: string,
  ): Promise<readonly unknown[]> {
    this.calls.push(`prepareRestore:${keysetId}:${start}:${count}`);
    return Array.from({ length: count }, (_, offset) => ({
      blindedMessage: {
        amount: 0,
        id: keysetId,
        B_: `${keysetId === '00aa' ? 'restore' : `restore-${keysetId}`}-${start + offset}`,
      },
    }));
  }

  async checkProofsStates(proofs: readonly unknown[]): Promise<readonly unknown[]> {
    this.calls.push(`checkProofs:${proofs.length}`);
    return proofs.map((proof) => {
      const secret = Reflect.get(proof as object, 'secret');
      return {
        Y: hashToCurve(new TextEncoder().encode(secret as string)).toHex(true),
        state: 'UNSPENT',
        witness: null,
      };
    });
  }

  getMintInfo(): unknown {
    return {
      isSupported: () => ({
        supported: true,
        params: { cached_endpoints: [{ method: 'POST', path: '/v1/mint/bolt11' }] },
      }),
    };
  }

  async restoreOutputs(outputs: readonly unknown[]): Promise<readonly unknown[]> {
    this.calls.push('restoreOutputs');
    const first = outputs[0];
    const blinded =
      typeof first === 'object' && first !== null
        ? Reflect.get(first, 'blindedMessage')
        : undefined;
    return typeof blinded === 'object' &&
      blinded !== null &&
      Reflect.get(blinded, 'B_') === 'restore-0'
      ? [
          {
            amount: 8,
            id: '00aa',
            secret: 'restored-proof-secret',
            C: `02${'77'.repeat(32)}`,
          },
        ]
      : [];
  }

  createMeltChangeProofs(): readonly unknown[] {
    return [];
  }

  async checkMeltQuoteBolt11(): Promise<unknown> {
    throw new Error('unused melt quote check');
  }
}

function harness(
  client: MintClient,
  store = new MemoryCashuTsLifecycleStore(),
  options: { readonly verifyLightningSettlement?: () => Promise<boolean> } = {},
) {
  const wallet = new CashuTsLifecycleWallet({
    mintUrl: mint,
    unit: 'sat',
    store,
    walletFactory: () => client,
    sleep: async () => {},
    ...(options.verifyLightningSettlement === undefined
      ? {}
      : {
          lightning: {
            settled: options.verifyLightningSettlement,
          },
        }),
  });
  const operations = new CashuTsLifecycleOperations({
    store,
    wallet,
    mint,
    unit: 'sat',
  });
  return { operations, store };
}

describe('CashuTsLifecycleWallet origin guard', () => {
  test('requires an explicit unsafe opt-in for non-loopback mint origins', () => {
    expect(
      () =>
        new CashuTsLifecycleWallet({
          mintUrl: 'https://mint.example.com',
          unit: 'sat',
          store: new MemoryCashuTsLifecycleStore(),
        }),
    ).toThrow('Cashu lifecycle external mint requires explicit HTTPS unsafe opt-in');

    expect(
      () =>
        new CashuTsLifecycleWallet({
          mintUrl: 'https://mint.example.com',
          unit: 'sat',
          store: new MemoryCashuTsLifecycleStore(),
          allowUnsafeMint: true,
        }),
    ).not.toThrow();

    expect(
      () =>
        new CashuTsLifecycleWallet({
          mintUrl: 'http://mint.example.com',
          unit: 'sat',
          store: new MemoryCashuTsLifecycleStore(),
          allowUnsafeMint: true,
        }),
    ).toThrow('Cashu lifecycle external mint requires explicit HTTPS unsafe opt-in');
    expect(
      () =>
        new CashuTsLifecycleWallet({
          mintUrl: 'file:///private/mint',
          unit: 'sat',
          store: new MemoryCashuTsLifecycleStore(),
          allowUnsafeMint: true,
        }),
    ).toThrow('Cashu lifecycle mint URL protocol is invalid');
  });

  test('uses manual redirect mode and refuses redirect and cross-origin requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', {
        status: 302,
        headers: {
          location: 'https://attacker.example/v1/mint/bolt11',
          'X-Cashu-Cached-Endpoints': '["/v1/mint/bolt11"]',
        },
      }),
    );
    const request = createCashuTsNoRedirectRequest('https://mint.example.com');
    const onResponseMeta = vi.fn();

    await expect(
      request({
        endpoint: 'https://mint.example.com/v1/mint/bolt11',
        requestBody: {},
        onResponseMeta,
      }),
    ).rejects.toThrow('Cashu lifecycle mint redirect is forbidden');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://mint.example.com/v1/mint/bolt11'),
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(onResponseMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://mint.example.com/v1/mint/bolt11',
        status: 302,
        headers: expect.any(Headers),
      }),
    );
    await expect(
      request({ endpoint: 'https://attacker.example/v1/mint/bolt11', requestBody: {} }),
    ).rejects.toThrow('Cashu lifecycle mint request changed origin');
    fetchMock.mockRestore();
  });

  test('adds the lifecycle operation identity only to the configured fault gateway request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const request = createCashuTsNoRedirectRequest('http://127.0.0.1:3338');

    await withCashuTsLifecycleOperation('AAAAAAAAAAAAAAAAAAAAAA', async () =>
      request({ endpoint: 'http://127.0.0.1:3338/v1/mint/bolt11', requestBody: {} }),
    );

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-cashu-fault-operation-id')).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    fetchMock.mockRestore();
  });

  test('enforces the requested timeout and a bounded mint response', async () => {
    const timeoutFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const request = createCashuTsNoRedirectRequest('https://mint.example.com');
    await expect(
      request({ endpoint: 'https://mint.example.com/v1/info', requestTimeout: 5 }),
    ).rejects.toThrow('Cashu lifecycle mint request failed');
    expect(timeoutFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    timeoutFetch.mockRestore();

    const oversizedFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: 'x'.repeat(1_048_576) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(request({ endpoint: 'https://mint.example.com/v1/info' })).rejects.toThrow(
      'Cashu lifecycle mint response exceeds byte limit',
    );
    oversizedFetch.mockRestore();
  });

  test('rejects credential, query, and fragment components in configured mint URLs', () => {
    for (const mintUrl of [
      'https://user:pass@mint.example.com',
      'https://mint.example.com?token=secret',
      'https://mint.example.com#secret',
    ]) {
      expect(
        () =>
          new CashuTsLifecycleWallet({
            mintUrl,
            unit: 'sat',
            store: new MemoryCashuTsLifecycleStore(),
            allowUnsafeMint: true,
          }),
      ).toThrow('forbidden components');
    }
  });

  test('derives mint support and does not advertise send without a durable handoff', async () => {
    const client = new MintClient();
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new CashuTsLifecycleWallet({
      mintUrl: mint,
      unit: 'sat',
      store,
      walletFactory: () => client,
    });
    const operations = new CashuTsLifecycleOperations({
      store,
      wallet,
      capabilities: {
        schemaVersion: 1,
        implementation: {
          id: 'cashu-ts',
          version: '4.7.2',
          language: 'typescript',
          runtime: 'node-24',
          sourceDigest: `sha256:${'a'.repeat(64)}`,
          buildDigest: `sha256:${'b'.repeat(64)}`,
        },
        operations: ['mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile'],
        nuts: [3, 4, 5, 7, 8, 9, 13, 19],
        durability: 'restart_safe',
        recovery: ['quote_state', 'proof_state', 'nut09_restore', 'nut13_seed', 'nut19_replay'],
        mints: [{ id: 'configured-mint', implementation: 'configured' }],
      },
    });

    await expect(operations.capabilities()).resolves.toMatchObject({
      operations: ['mint', 'swap', 'receive', 'melt', 'restore', 'reconcile'],
      nuts: [3, 4, 5, 7, 8, 9, 13, 19],
    });
  });
});

describe('CashuTsLifecycleWallet mint', () => {
  test('pins mint quote identity while polling for payment', async () => {
    const client = new MintClient();
    client.createMintQuoteBolt11 = async (amount) => ({
      quote: 'original-quote',
      request: 'lnbc-original',
      state: 'UNPAID',
      amount,
      unit: 'sat',
    });
    client.checkMintQuoteBolt11 = async () => ({
      quote: 'different-quote',
      request: 'lnbc-different',
      state: 'PAID',
      amount: 8,
      unit: 'sat',
    });
    const { operations } = harness(client);
    await operations.reset('mint-quote-identity');

    await expect(operations.start(mintInput)).rejects.toThrow(
      'Cashu lifecycle mint quote identity changed',
    );
    expect(client.calls).not.toContain(expect.stringMatching(/^prepareMint:/u));
  });

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

  test('rejects invalid mint proof cardinality before persisting any proof', async () => {
    const client = new MintClient();
    client.completeMint = async () => [
      { amount: 8, id: '00aa', secret: 'first-invalid-proof', C: `02${'12'.repeat(32)}` },
      { amount: 8, id: '00aa', secret: 'second-invalid-proof', C: `02${'13'.repeat(32)}` },
    ];
    const { operations, store } = harness(client);
    await operations.reset('mint-invalid-response');

    await expect(operations.start(mintInput)).rejects.toThrow(
      'Cashu lifecycle mint proof cardinality is invalid',
    );
    await expect(store.listProofs(mint, 'sat')).resolves.toEqual([]);
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

describe('CashuTsLifecycleWallet swap', () => {
  test('reserves persisted inputs and atomically replaces them with validated swap outputs', async () => {
    const client = new MintClient();
    const { operations, store } = harness(client);
    await operations.reset('swap-wallet-seed');
    await operations.start(mintInput);

    await expect(operations.start(swapInput)).resolves.toMatchObject({
      kind: 'swap',
      phase: 'succeeded',
      amount: 4,
      inputFee: 0,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      outputPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
      proofs: expect.arrayContaining([
        expect.objectContaining({ state: 'SPENT' }),
        expect.objectContaining({ state: 'UNSPENT' }),
        expect.objectContaining({ state: 'UNSPENT' }),
      ]),
    });
    expect((await store.get(swapInput.operationId))?.prepared).toMatchObject({
      method: 'POST',
      path: '/v1/swap',
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requestMaterial: {
        kind: 'swap',
        inputProofIds: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
        preview: expect.any(Object),
      },
    });
    const expectedBody = JSONInt.stringify({
      inputs: [
        {
          amount: 8,
          id: '00aa',
          secret: 'minted-proof-secret',
          C: `02${'11'.repeat(32)}`,
        },
      ],
      outputs: [
        { amount: 4, id: '00aa', B_: 'swap-keep' },
        { amount: 4, id: '00aa', B_: 'swap-send' },
      ],
    });
    expect(expectedBody).toBeDefined();
    expect((await store.get(swapInput.operationId))?.prepared?.bodyHash).toBe(
      createHash('sha256')
        .update('cashu-fault-lab/cashu-ts-lifecycle-http-body/v1\0')
        .update(expectedBody!)
        .digest('hex'),
    );
    expect(client.calls.map((call) => call.split(':')[0])).toContain('prepareSwap');
    expect(client.calls).toContain('completeSwap');
  });

  test('keeps cashu-ts unselected proofs without treating them as fresh outputs', async () => {
    const client = new MintClient();
    client.prepareSwapToSend = async (amount, proofs) => {
      const selected = proofs.find((proof) => Reflect.get(proof as object, 'amount') === 8);
      const unselected = proofs.find((proof) => Reflect.get(proof as object, 'amount') === 4);
      if (selected === undefined || unselected === undefined)
        throw new Error('missing test proofs');
      return {
        amount,
        fees: 0,
        inputs: [selected],
        unselectedProofs: [unselected],
        sendOutputs: [{ blindedMessage: { amount: 4, id: '00aa', B_: 'subset-send' } }],
        keepOutputs: [{ blindedMessage: { amount: 4, id: '00aa', B_: 'subset-keep' } }],
        keysetId: '00aa',
      };
    };
    client.completeSwap = async (preview?: unknown) => ({
      keep: [
        { amount: 4, id: '00aa', secret: 'subset-keep-secret', C: `02${'34'.repeat(32)}` },
        ...((preview === undefined
          ? []
          : (Reflect.get(preview as object, 'unselectedProofs') as readonly unknown[])) ?? []),
      ],
      send: [{ amount: 4, id: '00aa', secret: 'subset-send-secret', C: `02${'35'.repeat(32)}` }],
    });
    const { operations, store } = harness(client);
    await operations.reset('swap-subset-selection');
    await operations.start(mintInput);
    await store.applyProofChanges({
      operationId: mintInput.operationId,
      add: [
        {
          proofId: '4'.repeat(64),
          mint,
          unit: 'sat',
          amount: 4,
          state: 'UNSPENT',
          bucket: 'available',
          material: {
            amount: 4,
            id: '00aa',
            secret: 'unselected-proof-secret',
            C: `02${'36'.repeat(32)}`,
          },
        },
      ],
      update: [],
    });

    await expect(operations.start(swapInput)).resolves.toMatchObject({ phase: 'succeeded' });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 12, reserved: 0, recoverable: 0 },
    });
  });
});

describe('CashuTsLifecycleWallet send', () => {
  test('durably exports the exact token while retaining only change proofs', async () => {
    const client = new MintClient();
    const { operations, store } = harness(client);
    await operations.reset('send-wallet-seed');
    await operations.start(mintInput);

    await expect(operations.start(sendInput)).resolves.toMatchObject({
      kind: 'send',
      phase: 'succeeded',
      amount: 4,
      inputFee: 0,
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 4, reserved: 0, recoverable: 0 },
    });
    const stored = await store.get(sendInput.operationId);
    expect(stored?.resultMaterial).toMatchObject({
      kind: 'send',
      recipient: 'bob',
      token: expect.stringMatching(/^cashu/u),
    });
    expect(JSON.stringify(await operations.operation(sendInput.operationId))).not.toContain(
      (stored?.resultMaterial as { token: string }).token,
    );
    await expect(store.loadSendHandoff(sendInput.operationId)).resolves.toEqual({
      recipient: 'bob',
      token: (stored?.resultMaterial as { token: string }).token,
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(operations.evidence()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'durable_state', event: 'token_outbox_persisted' }),
      ]),
    );
  });
});

describe('CashuTsLifecycleWallet receive', () => {
  test('persists the secret token before swapping and stores only validated fresh proofs', async () => {
    const client = new MintClient();
    client.completeSwap = async () => {
      client.calls.push('completeSwap');
      return {
        keep: [
          {
            amount: 8,
            id: '00aa',
            secret: 'received-fresh-secret',
            C: `02${'55'.repeat(32)}`,
          },
        ],
        send: [],
      };
    };
    const { operations, store } = harness(client);
    await operations.reset('receive-wallet-seed');

    await expect(operations.start(receiveInput)).resolves.toMatchObject({
      kind: 'receive',
      phase: 'succeeded',
      amount: 8,
      inputFee: 0,
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
    });
    expect((await store.get(receiveInput.operationId))?.prepared).toMatchObject({
      requestMaterial: {
        kind: 'receive',
        token: receiveInput.token,
        preview: expect.any(Object),
      },
    });
    expect(JSON.stringify(await operations.operation(receiveInput.operationId))).not.toContain(
      receiveInput.token,
    );
  });

  test('rejects a receive response that reuses an input proof identity', async () => {
    const client = new MintClient();
    client.completeSwap = async () => ({
      keep: [
        {
          amount: 8,
          id: '00aa',
          secret: 'receive-input-secret',
          C: `02${'45'.repeat(32)}`,
        },
      ],
      send: [],
    });
    const { operations, store } = harness(client);
    await operations.reset('receive-reused-input');

    await expect(operations.start(receiveInput)).rejects.toThrow(
      'Cashu lifecycle receive output reuses an input identity',
    );
    await expect(store.listProofs(mint, 'sat')).resolves.toEqual([]);
  });
});

describe('CashuTsLifecycleWallet melt', () => {
  test('requires independent settlement and atomically persists NUT-08 change', async () => {
    const client = new MintClient();
    client.getFeesForProofs = () => 1;
    let settlementChecks = 0;
    const { operations } = harness(client, new MemoryCashuTsLifecycleStore(), {
      verifyLightningSettlement: async () => {
        settlementChecks += 1;
        return true;
      },
    });
    await operations.reset('melt-wallet-seed');
    await operations.start(mintInput);

    await expect(operations.start(meltInput)).resolves.toMatchObject({
      kind: 'melt',
      phase: 'succeeded',
      amount: 6,
      feeReserve: 2,
      inputFee: 1,
      actualFee: 0,
      change: 1,
      quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 1, reserved: 0, recoverable: 0 },
    });
    expect(settlementChecks).toBe(1);
    await expect(operations.evidence()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'lightning', event: 'settlement_verified' }),
      ]),
    );
    expect(JSON.stringify(await operations.evidence())).not.toContain('never-expose-melt-preimage');
  });
});

describe('CashuTsLifecycleWallet restore', () => {
  test('rejects a NUT-09 signature whose keyset or amount does not match its output', () => {
    expect(() =>
      assertCashuTsRestoreResponsePair(
        { id: '00aa', amount: 8 },
        { id: '00aa', amount: 8 },
        { id: '00bb', amount: 8 },
      ),
    ).toThrow('Cashu lifecycle restore response identity is invalid');
    expect(() =>
      assertCashuTsRestoreResponsePair(
        { id: '00aa', amount: 8 },
        { id: '00aa', amount: 8 },
        { id: '00aa', amount: 4 },
      ),
    ).toThrow('Cashu lifecycle restore response identity is invalid');
  });

  test('persists the deterministic NUT-13 range before requesting restore signatures', async () => {
    const client = new MintClient();
    const { operations, store } = harness(client);
    await operations.reset('restore-wallet-seed');

    await expect(operations.start(restoreInput)).resolves.toMatchObject({
      kind: 'restore',
      phase: 'succeeded',
      amount: 8,
      outputPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((await store.get(restoreInput.operationId))?.prepared).toMatchObject({
      requestMaterial: {
        kind: 'restore',
        start: 0,
        count: 192,
        batchSize: 64,
        keysetId: '00aa',
        outputs: expect.any(Array),
        keysets: [expect.objectContaining({ keysetId: '00aa', count: 192 })],
      },
    });
    expect((await store.get(restoreInput.operationId))?.prepared?.requestDigests).toHaveLength(3);
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
    });
  });

  test('scans beyond every counter range already reserved for the seed', async () => {
    const client = new MintClient();
    const { operations, store } = harness(client);
    await operations.reset('restore-counter-watermark');
    await operations.start(mintInput);
    await operations.start(swapInput);

    expect(client.counters).toEqual([0, 64, 128]);
    await operations.start(restoreInput);
    expect((await store.get(restoreInput.operationId))?.prepared).toMatchObject({
      requestMaterial: {
        count: 384,
        outputs: expect.arrayContaining([
          expect.objectContaining({
            blindedMessage: expect.objectContaining({ B_: 'restore-383' }),
          }),
        ]),
      },
    });
  });

  test('scans durable counter ranges for inactive keysets after rotation', async () => {
    const client = new MintClient();
    const { operations, store } = harness(client);
    await operations.reset('restore-rotated-keyset');
    await store.reserveCounterRange('00bb', 'historical-operation', 64);

    await operations.start(restoreInput);
    expect((await store.get(restoreInput.operationId))?.prepared).toMatchObject({
      requestMaterial: {
        keysets: expect.arrayContaining([
          expect.objectContaining({ keysetId: '00aa', count: 192 }),
          expect.objectContaining({ keysetId: '00bb', count: 256 }),
        ]),
      },
      requestDigests: expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/v1/restore' }),
      ]),
    });
    expect(client.calls).toContain('prepareRestore:00bb:0:256');
  });

  test('does not resurrect restored proofs that NUT-07 reports spent', async () => {
    const client = new MintClient();
    client.checkProofsStates = async (proofs) =>
      proofs.map((proof) => ({
        Y: hashToCurve(
          new TextEncoder().encode(Reflect.get(proof as object, 'secret') as string),
        ).toHex(true),
        state: 'SPENT',
        witness: null,
      }));
    const { operations } = harness(client);
    await operations.reset('restore-spent-proof');

    await expect(operations.start(restoreInput)).resolves.toMatchObject({
      phase: 'succeeded',
      amount: 0,
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 0, reserved: 0, recoverable: 0 },
      proofs: [{ state: 'SPENT' }],
    });
  });
});

describe('CashuTsLifecycleWallet reconcile', () => {
  test('validates NUT-07 identities before releasing target operation reservations', async () => {
    const client = new MintClient();
    client.completeMelt = async () => ({
      quote: {
        quote: 'secret-melt-quote-id',
        request: meltInput.kind === 'melt' ? meltInput.invoice : '',
        unit: 'sat',
        amount: 6,
        fee_reserve: 2,
        state: 'PENDING',
        payment_preimage: null,
      },
      change: [],
      outputData: [],
    });
    const { operations, store } = harness(client);
    await operations.reset('reconcile-wallet-seed');
    await operations.start(mintInput);
    await expect(operations.start(meltInput)).resolves.toMatchObject({ phase: 'ambiguous' });
    await expect(store.get(meltInput.operationId)).resolves.toMatchObject({
      quoteObservations: [
        expect.objectContaining({ state: 'UNPAID' }),
        expect.objectContaining({ state: 'PENDING' }),
      ],
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 0, reserved: 8, recoverable: 0 },
    });

    await expect(operations.start(reconcileInput)).resolves.toMatchObject({
      kind: 'reconcile',
      phase: 'succeeded',
      amount: 8,
    });
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
    });
  });
});

describe('CashuTsLifecycleWallet recovery', () => {
  test('uses NUT-07 then NUT-09 without a second swap when NUT-19 is unavailable', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let swapCalls = 0;
    client.completeSwap = async () => {
      swapCalls += 1;
      throw new Error('swap committed and response was lost');
    };
    client.checkProofsStates = async (proofs) =>
      proofs.map((proof) => ({
        Y: hashToCurve(
          new TextEncoder().encode(Reflect.get(proof as object, 'secret') as string),
        ).toHex(true),
        state: 'SPENT',
        witness: null,
      }));
    client.restoreOutputs = async () => {
      client.calls.push('restoreOutputs');
      return [
        { amount: 4, id: '00aa', secret: 'restored-keep-secret', C: `02${'88'.repeat(32)}` },
        { amount: 4, id: '00aa', secret: 'restored-send-secret', C: `02${'99'.repeat(32)}` },
      ];
    };
    const { operations } = harness(client);
    await operations.reset('swap-nut09-recovery');
    await operations.start(mintInput);
    await expect(operations.start(swapInput)).rejects.toThrow(
      'swap committed and response was lost',
    );

    await expect(operations.resume(swapInput.operationId)).resolves.toMatchObject({
      phase: 'succeeded',
      amount: 4,
    });
    expect(swapCalls).toBe(1);
    expect(client.calls).toContain('restoreOutputs');
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
    });
  });

  test('blocks recovery and retains reservations when spent inputs lack exact NUT-09 outputs', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let swapCalls = 0;
    client.completeSwap = async () => {
      swapCalls += 1;
      throw new Error('swap committed and response was lost');
    };
    client.checkProofsStates = async (proofs) =>
      proofs.map((proof) => ({
        Y: hashToCurve(
          new TextEncoder().encode(Reflect.get(proof as object, 'secret') as string),
        ).toHex(true),
        state: 'SPENT',
        witness: null,
      }));
    client.restoreOutputs = async () => [];
    const { operations } = harness(client);
    await operations.reset('swap-recovery-blocked');
    await operations.start(mintInput);
    await expect(operations.start(swapInput)).rejects.toThrow(
      'swap committed and response was lost',
    );

    await expect(operations.resume(swapInput.operationId)).resolves.toMatchObject({
      phase: 'recovery_blocked',
      evidenceCode: 'nut09_restore_incomplete',
    });
    expect(swapCalls).toBe(1);
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 0, reserved: 8, recoverable: 0 },
    });
  });

  test('retains reservations when a single NUT-07 snapshot reports ambiguous inputs unspent', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let swapCalls = 0;
    client.completeSwap = async () => {
      swapCalls += 1;
      throw new Error('swap committed and response was lost');
    };
    const { operations } = harness(client);
    await operations.reset('swap-unspent-without-fence');
    await operations.start(mintInput);
    await expect(operations.start(swapInput)).rejects.toThrow(
      'swap committed and response was lost',
    );

    await expect(operations.resume(swapInput.operationId)).resolves.toMatchObject({
      phase: 'recovery_blocked',
      evidenceCode: 'inputs_unspent_without_replay_fence',
    });
    expect(swapCalls).toBe(1);
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 0, reserved: 8, recoverable: 0 },
    });
  });

  test('restores the exact receive output after NUT-07 proves incoming inputs spent', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let swapCalls = 0;
    client.completeSwap = async () => {
      swapCalls += 1;
      throw new Error('receive committed and response was lost');
    };
    client.checkProofsStates = async (proofs) =>
      proofs.map((proof) => ({
        Y: hashToCurve(
          new TextEncoder().encode(Reflect.get(proof as object, 'secret') as string),
        ).toHex(true),
        state: 'SPENT',
        witness: null,
      }));
    client.restoreOutputs = async () => [
      { amount: 8, id: '00aa', secret: 'restored-receive-secret', C: `02${'aa'.repeat(32)}` },
    ];
    const { operations } = harness(client);
    await operations.reset('receive-nut09-recovery');
    await expect(operations.start(receiveInput)).rejects.toThrow(
      'receive committed and response was lost',
    );

    await expect(operations.resume(receiveInput.operationId)).resolves.toMatchObject({
      phase: 'succeeded',
      amount: 8,
    });
    expect(swapCalls).toBe(1);
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
    });
  });

  test('recovers issued mint outputs with quote state and NUT-09 without issuing twice', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let mintCalls = 0;
    client.completeMint = async () => {
      mintCalls += 1;
      throw new Error('mint committed and response was lost');
    };
    client.checkMintQuoteBolt11 = async () => ({
      quote: 'secret-mint-quote-id',
      request: 'lnbc-secret-invoice',
      state: 'ISSUED',
      amount: 8,
      unit: 'sat',
    });
    client.restoreOutputs = async () => [
      { amount: 8, id: '00aa', secret: 'restored-mint-secret', C: `02${'ac'.repeat(32)}` },
    ];
    const { operations } = harness(client);
    await operations.reset('mint-quote-nut09-recovery');
    await expect(operations.start(mintInput)).rejects.toThrow(
      'mint committed and response was lost',
    );

    await expect(operations.resume(mintInput.operationId)).resolves.toMatchObject({
      phase: 'succeeded',
      amount: 8,
    });
    expect(mintCalls).toBe(1);
    await expect(operations.wallet()).resolves.toMatchObject({
      balances: { available: 8, reserved: 0, recoverable: 0 },
    });
  });

  test('blocks paid mint recovery without NUT-19 or exact NUT-09 outputs', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let mintCalls = 0;
    client.completeMint = async () => {
      mintCalls += 1;
      throw new Error('mint committed and response was lost');
    };
    client.checkMintQuoteBolt11 = async () => ({
      quote: 'secret-mint-quote-id',
      request: 'lnbc-secret-invoice',
      state: 'PAID',
      amount: 8,
      unit: 'sat',
    });
    client.restoreOutputs = async () => [];
    const { operations } = harness(client);
    await operations.reset('mint-paid-no-replay-no-restore');
    await expect(operations.start(mintInput)).rejects.toThrow(
      'mint committed and response was lost',
    );

    await expect(operations.resume(mintInput.operationId)).resolves.toMatchObject({
      phase: 'recovery_blocked',
      evidenceCode: 'nut09_restore_incomplete',
    });
    expect(mintCalls).toBe(1);
  });

  test('polls a pending melt quote and recovers NUT-08 change without paying twice', async () => {
    const client = new MintClient();
    client.getMintInfo = () => ({ isSupported: () => ({ supported: false }) });
    let meltCalls = 0;
    client.completeMelt = async () => {
      meltCalls += 1;
      throw new Error('melt committed and response was lost');
    };
    let quoteChecks = 0;
    client.checkMeltQuoteBolt11 = async () => {
      quoteChecks += 1;
      return {
        quote: 'secret-melt-quote-id',
        request: meltInput.kind === 'melt' ? meltInput.invoice : '',
        unit: 'sat',
        amount: 6,
        fee_reserve: 2,
        state: quoteChecks === 1 ? 'PENDING' : 'PAID',
        payment_preimage: quoteChecks === 1 ? null : 'never-expose-polled-preimage',
        change: [{ amount: 1, id: '00aa', C_: 'blind-signature' }],
      };
    };
    client.createMeltChangeProofs = () => [
      { amount: 1, id: '00aa', secret: 'polled-change-secret', C: `02${'ab'.repeat(32)}` },
    ];
    const { operations } = harness(client, new MemoryCashuTsLifecycleStore(), {
      verifyLightningSettlement: async () => true,
    });
    await operations.reset('melt-quote-recovery');
    await operations.start(mintInput);
    await expect(operations.start(meltInput)).rejects.toThrow(
      'melt committed and response was lost',
    );

    await expect(operations.resume(meltInput.operationId)).resolves.toMatchObject({
      phase: 'succeeded',
      amount: 6,
      actualFee: 1,
      change: 1,
    });
    expect(meltCalls).toBe(1);
    expect(quoteChecks).toBe(2);
    expect(JSON.stringify(await operations.evidence())).not.toContain(
      'never-expose-polled-preimage',
    );
  });
});
