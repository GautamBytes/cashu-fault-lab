import type { FastifyInstance } from 'fastify';
import { FundedCashuTsOperations, type CashuTsDeliveryStore } from './funded-operations.js';
import {
  FundedCashuTsDualRoleOperations,
  FundedCashuTsReceiverOperations,
} from './funded-receiver-operations.js';
import { FundedCashuTsWallet } from './funded-wallet.js';
import { CashuTsHttpTransport } from './http-transport.js';
import { buildCashuTsAdapterServer, type CashuTsAdapterServerOptions } from './server.js';

export interface FundedCashuTsAdapterServerOptions {
  readonly mintUrl: string;
  readonly fundingAmount: number;
  readonly now?: () => number;
  readonly controlToken?: string;
  readonly testMode?: boolean;
  readonly store?: CashuTsDeliveryStore;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly proofClaimKey?: Uint8Array;
  readonly paymentTarget?: string;
}

export async function buildFundedCashuTsAdapterServer(
  options: FundedCashuTsAdapterServerOptions,
): Promise<FastifyInstance> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const sender = new FundedCashuTsOperations({
    wallet: new FundedCashuTsWallet({
      mintUrl: options.mintUrl,
      fundingAmount: options.fundingAmount,
    }),
    transport: new CashuTsHttpTransport({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    }),
    ...(options.store === undefined ? {} : { store: options.store }),
    now,
  });
  const receiverEnabled =
    options.proofClaimKey !== undefined || options.paymentTarget !== undefined;
  if (
    receiverEnabled &&
    (options.proofClaimKey === undefined || options.paymentTarget === undefined)
  ) {
    throw new Error('cashu-ts receiver requires both proofClaimKey and paymentTarget');
  }
  const operations = receiverEnabled
    ? new FundedCashuTsDualRoleOperations({
        sender,
        receiver: new FundedCashuTsReceiverOperations({
          mintUrl: options.mintUrl,
          paymentTarget: options.paymentTarget!,
          proofClaimKey: options.proofClaimKey!,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          now,
        }),
      })
    : sender;
  const serverOptions: CashuTsAdapterServerOptions = {
    now,
    operations,
    ...(options.controlToken === undefined ? {} : { controlToken: options.controlToken }),
    ...(options.testMode === undefined ? {} : { testMode: options.testMode }),
  };
  return buildCashuTsAdapterServer(serverOptions);
}
