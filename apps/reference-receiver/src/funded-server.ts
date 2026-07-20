import type { FastifyInstance } from 'fastify';
import { CashuTsMintGateway, type MintFetch } from './adapters/cashu-ts-mint.js';
import { CashuTsProofVerifier } from './adapters/cashu-ts-proof-verifier.js';
import { MemoryReceiverStore } from './adapters/memory-store.js';
import { FundedReceiverAdapterControl } from './funded-adapter.js';
import { buildReceiverHttpServer } from './http/server.js';

export interface FundedReceiverAdapterServerOptions {
  readonly mintUrl: string;
  readonly paymentTarget: string;
  readonly proofClaimKey: Uint8Array;
  readonly controlToken?: string;
  readonly testMode?: boolean;
  readonly now?: () => number;
  readonly fetch?: MintFetch;
}

export async function buildFundedReceiverAdapterServer(
  options: FundedReceiverAdapterServerOptions,
): Promise<FastifyInstance> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const store = new MemoryReceiverStore();
  const control = new FundedReceiverAdapterControl({
    store,
    mintUrl: options.mintUrl,
    paymentTarget: options.paymentTarget,
    now,
  });
  return buildReceiverHttpServer({
    accept: {
      store,
      mint: new CashuTsMintGateway({
        now,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      verifier: new CashuTsProofVerifier({
        proofClaimKey: options.proofClaimKey,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      now,
    },
    adapter: {
      control,
      ...(options.controlToken === undefined ? {} : { controlToken: options.controlToken }),
      ...(options.testMode === undefined ? {} : { testMode: options.testMode }),
    },
  });
}
