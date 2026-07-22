import type { FastifyInstance } from 'fastify';
import { FundedCashuTsOperations, type CashuTsDeliveryStore } from './funded-operations.js';
import {
  FundedCashuTsDualRoleOperations,
  FundedCashuTsReceiverOperations,
  type ResettableReceiverStore,
} from './funded-receiver-operations.js';
import { FundedCashuTsWallet } from './funded-wallet.js';
import { CashuTsHttpTransport } from './http-transport.js';
import { CashuTsCompositeTransport, CashuTsNostrTransport } from './nostr-transport.js';
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
  readonly receiverStore?: ResettableReceiverStore;
  readonly senderNostrPrivateKey?: Uint8Array;
  readonly receiverNostrPrivateKey?: Uint8Array;
  readonly nostrRelayUrls?: readonly string[];
  readonly nostrTimeoutMs?: number;
  readonly nostrPollIntervalMs?: number;
  readonly senderNostrPollAttempts?: number;
  readonly senderNostrPollDelayMs?: number;
}

export async function buildFundedCashuTsAdapterServer(
  options: FundedCashuTsAdapterServerOptions,
): Promise<FastifyInstance> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const httpTransport = new CashuTsHttpTransport({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
  });
  const transport =
    options.senderNostrPrivateKey === undefined
      ? httpTransport
      : new CashuTsCompositeTransport({
          http: httpTransport,
          nostr: new CashuTsNostrTransport({
            senderPrivateKey: options.senderNostrPrivateKey,
            now,
            ...(options.nostrTimeoutMs === undefined ? {} : { timeoutMs: options.nostrTimeoutMs }),
            ...(options.senderNostrPollAttempts === undefined
              ? {}
              : { pollAttempts: options.senderNostrPollAttempts }),
            ...(options.senderNostrPollDelayMs === undefined
              ? {}
              : { pollDelayMs: options.senderNostrPollDelayMs }),
          }),
        });
  const sender = new FundedCashuTsOperations({
    wallet: new FundedCashuTsWallet({
      mintUrl: options.mintUrl,
      fundingAmount: options.fundingAmount,
    }),
    transport,
    ...(options.store === undefined ? {} : { store: options.store }),
    supportedTransports: options.senderNostrPrivateKey === undefined ? ['http'] : ['http', 'nostr'],
    now,
  });
  const receiverEnabled =
    options.proofClaimKey !== undefined ||
    options.paymentTarget !== undefined ||
    options.receiverNostrPrivateKey !== undefined ||
    options.nostrRelayUrls !== undefined ||
    options.receiverStore !== undefined;
  if (receiverEnabled && options.proofClaimKey === undefined) {
    throw new Error('cashu-ts receiver requires proofClaimKey');
  }
  if ((options.receiverNostrPrivateKey === undefined) !== (options.nostrRelayUrls === undefined)) {
    throw new Error('cashu-ts Nostr receiver requires both a private key and relay URLs');
  }
  let receiver: FundedCashuTsReceiverOperations | undefined;
  if (receiverEnabled) {
    receiver = new FundedCashuTsReceiverOperations({
      mintUrl: options.mintUrl,
      ...(options.paymentTarget === undefined ? {} : { paymentTarget: options.paymentTarget }),
      proofClaimKey: options.proofClaimKey!,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.receiverStore === undefined ? {} : { store: options.receiverStore }),
      ...(options.receiverNostrPrivateKey === undefined
        ? {}
        : { receiverNostrPrivateKey: options.receiverNostrPrivateKey }),
      ...(options.nostrRelayUrls === undefined ? {} : { nostrRelayUrls: options.nostrRelayUrls }),
      ...(options.nostrTimeoutMs === undefined ? {} : { nostrTimeoutMs: options.nostrTimeoutMs }),
      ...(options.nostrPollIntervalMs === undefined
        ? {}
        : { nostrPollIntervalMs: options.nostrPollIntervalMs }),
      now,
    });
  }
  const operations =
    receiver === undefined
      ? sender
      : new FundedCashuTsDualRoleOperations({
          sender,
          receiver,
        });
  const serverOptions: CashuTsAdapterServerOptions = {
    now,
    operations,
    ...(options.controlToken === undefined ? {} : { controlToken: options.controlToken }),
    ...(options.testMode === undefined ? {} : { testMode: options.testMode }),
  };
  const app = await buildCashuTsAdapterServer(serverOptions);
  receiver?.startNostr();
  app.addHook('onClose', async () => {
    receiver?.stopNostr();
  });
  return app;
}
