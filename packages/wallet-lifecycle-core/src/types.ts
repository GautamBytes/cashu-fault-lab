export const LIFECYCLE_OPERATION_KINDS = [
  'mint',
  'swap',
  'send',
  'receive',
  'melt',
  'restore',
  'reconcile',
] as const;

export type LifecycleOperationKind = (typeof LIFECYCLE_OPERATION_KINDS)[number];

export const LIFECYCLE_PHASES = [
  'created',
  'prepared',
  'submitted',
  'ambiguous',
  'reconciling',
  'succeeded',
  'failed_definitive',
  'recovery_blocked',
] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface LifecycleOperationIdentity {
  readonly operationId: string;
  readonly kind: LifecycleOperationKind;
  readonly mint: string;
  readonly unit: string;
  readonly intentHash: string;
}

export interface LifecycleOperationRecord extends LifecycleOperationIdentity {
  readonly phase: LifecyclePhase;
  readonly evidenceCode?: string;
}
