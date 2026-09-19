import type { Event, Filter } from 'nostr-tools';
import type { Nutzap, NutzapProof } from './protocol.js';
export interface PreparedRedemption {
  material: string;
  outputs: { secret: string; amount: number; id: string }[];
  fee: number;
}
export interface MintPort {
  prepareSpend?(proofs: NutzapProof[], amount: number): Promise<PreparedSpend>;
  prepare(zap: Nutzap): Promise<PreparedRedemption>;
  swap(zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]>;
  restore(zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]>;
  states(proofs: NutzapProof[]): Promise<('UNSPENT' | 'SPENT' | 'PENDING')[]>;
  verify(proofs: NutzapProof[]): Promise<void>;
}
export interface PreparedSpend extends PreparedRedemption {
  sendSecrets: string[];
}
export interface RedemptionRecord {
  zap: Nutzap;
  plan: PreparedRedemption;
  credit: number | null;
  events: Event[];
  published: string[];
  historyRelays?: string[];
  origin?: 'local' | 'relay';
  wallet?: { token: Event | null; proofs: NutzapProof[]; retired: string[] };
  spend?: { amount: number; plan: PreparedSpend; events: Event[]; sent: NutzapProof[] };
}
export interface ReceiverOptions {
  database: string;
  key: Uint8Array;
  info: Event;
  relays: string[];
  mint: MintPort;
  publish: (relay: string, event: Event) => Promise<void>;
  query?: (relay: string, filter: Filter) => Promise<Event[]>;
  senderRelayQuery?: (relay: string, filter: Filter) => Promise<Event[]>;
  afterSwap?: () => Promise<void>;
}
export type ReceiveResult =
  'complete' | 'pending' | 'recovery-blocked' | 'publication-pending' | 'awaiting-peer';
