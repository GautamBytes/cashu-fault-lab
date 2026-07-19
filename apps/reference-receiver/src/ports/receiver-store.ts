import type { DeliveryReceipt } from '@cashu-fault-lab/delivery-core';
import type {
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
