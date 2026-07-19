import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type {
  AcceptDeliveryCommand,
  CommitSettlement,
  CreatePaymentRequest,
  DeliveryRecord,
  MerchantCredit,
  PaymentRequestRecord,
  PrepareDelivery,
  PrepareResult,
} from '../domain/types.js';

export interface ReceiverStore {
  createRequest(input: CreatePaymentRequest): Promise<PaymentRequestRecord>;
  preflight(command: AcceptDeliveryCommand, now: number): Promise<DeliveryRecord | undefined>;
  withRedemptionLock<T>(
    deliveryId: string,
    operation: (lockedStore: ReceiverStore) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }>;
  prepare(input: PrepareDelivery): Promise<PrepareResult>;
  markMintSent(deliveryId: string): Promise<DeliveryReceipt>;
  settle(input: CommitSettlement): Promise<DeliveryReceipt>;
  blockRecovery(deliveryId: string): Promise<DeliveryReceipt>;
  reject(deliveryId: string, detailCode: string, releaseClaims: boolean): Promise<DeliveryReceipt>;
  current(deliveryId: string): Promise<DeliveryRecord | undefined>;
  settlementPlans(): Promise<readonly ExactSwapPlanView[]>;
  credits(): Promise<readonly MerchantCredit[]>;
}

export interface ExactSwapPlanView {
  readonly deliveryId: string;
  readonly mint: string;
  readonly unit: string;
  readonly expectedAmount: number;
}
