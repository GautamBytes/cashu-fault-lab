import type { Event } from 'nostr-tools';
import type { Nutzap, NutzapProof } from './protocol.js';
export interface PreparedRedemption {
  material: string;
  outputs: { secret: string; amount: number; id: string }[];
  fee: number;
}
export interface MintPort {
  prepare(zap: Nutzap): Promise<PreparedRedemption>;
  swap(zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]>;
  restore(zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]>;
  states(proofs: NutzapProof[]): Promise<('UNSPENT' | 'SPENT' | 'PENDING')[]>;
}
export interface RedemptionRecord {
  zap: Nutzap;
  plan: PreparedRedemption;
  credit: number | null;
  events: Event[];
  published: string[];
}
export interface ReceiverOptions {
  database: string;
  key: Uint8Array;
  info: Event;
  relays: string[];
  mint: MintPort;
  publish: (relay: string, event: Event) => Promise<void>;
  afterSwap?: () => Promise<void>;
}
export type ReceiveResult = 'complete' | 'pending' | 'recovery-blocked' | 'publication-pending';
