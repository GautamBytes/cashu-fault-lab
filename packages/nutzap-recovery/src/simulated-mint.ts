import { randomBytes } from 'node:crypto';
import { digest, type Nutzap, type NutzapProof } from './protocol.js';
import type { MintPort, PreparedRedemption } from './types.js';

/** Deterministic semantic oracle, not cryptographic mint interoperability evidence. */
export class SimulatedMint implements MintPort {
  readonly #spent = new Set<string>();
  readonly #outputs = new Map<string, NutzapProof[]>();
  readonly #source: NutzapProof;
  successfulSwaps = 0;
  constructor(lockingKey: string, seed: string) {
    this.#source = {
      id: '001234567890abcd',
      amount: 16,
      C: `02${lockingKey}`,
      secret: JSON.stringify(['P2PK', { nonce: digest(seed), data: `02${lockingKey}` }]),
      dleq: { e: '01'.repeat(32), s: '02'.repeat(32), r: '03'.repeat(32) },
    };
  }
  source(): NutzapProof[] {
    return [this.#source];
  }
  async prepare(zap: Nutzap): Promise<PreparedRedemption> {
    const secret = randomBytes(32).toString('hex');
    return {
      material: secret,
      fee: 1,
      outputs: [{ secret, id: this.#source.id, amount: zap.amount - 1 }],
    };
  }
  async swap(zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]> {
    if (zap.proofs.some((p) => this.#spent.has(p.secret))) throw Error('Inputs spent');
    for (const p of zap.proofs) this.#spent.add(p.secret);
    const proofs = plan.outputs.map((p) => ({ ...p, C: this.#source.C }));
    this.#outputs.set(plan.material, proofs);
    this.successfulSwaps++;
    return proofs;
  }
  async restore(_zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]> {
    return this.#outputs.get(plan.material) ?? [];
  }
  async states(proofs: NutzapProof[]): Promise<('UNSPENT' | 'SPENT')[]> {
    return proofs.map((p) => (this.#spent.has(p.secret) ? 'SPENT' : 'UNSPENT'));
  }
  async verify(proofs: NutzapProof[]): Promise<void> {
    const issued = [...this.#outputs.values()].flat();
    if (
      proofs.some(
        (p) =>
          !issued.some(
            (q) => q.id === p.id && q.secret === p.secret && q.amount === p.amount && q.C === p.C,
          ),
      )
    )
      throw Error('Unknown simulated output');
  }
}
