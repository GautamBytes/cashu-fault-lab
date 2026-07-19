import { Amount, type Proof, type SendResponse } from '@cashu/cashu-ts';
import type { ProtocolId } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  CashuTsSenderWallet,
  InMemorySenderReservationStore,
  type CashuTsOfflineWallet,
  type CashuTsWalletAccount,
} from '../src/index.js';

const firstDelivery = 'AAECAwQFBgcICQoLDA0ODw' as ProtocolId;
const secondDelivery = 'EBESExQVFhcYGRobHB0eHw' as ProtocolId;

function proof(amount: number, secret: string): Proof {
  return {
    amount: Amount.from(amount),
    id: '00aabbccddeeff00',
    secret,
    C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  };
}

class OfflineWallet implements CashuTsOfflineWallet {
  calls = 0;
  readonly fee: number;

  constructor(fee: number) {
    this.fee = fee;
  }

  readonly ops = {
    send: (_amount: number, proofs: readonly Proof[]) => {
      let includeFees = false;
      let exact = false;
      const builder = {
        includeFees: (on = true) => {
          includeFees = on;
          return builder;
        },
        offlineExactOnly: () => {
          exact = true;
          return builder;
        },
        privkey: () => builder,
        run: async (): Promise<SendResponse> => {
          this.calls += 1;
          if (!includeFees || !exact) throw new Error('unsafe cashu-ts send configuration');
          const selected = proofs.find(
            (candidate) => candidate.amount.toNumber() - this.fee === _amount,
          );
          if (!selected) throw new Error('No exact offline proof set');
          return {
            send: [selected],
            keep: proofs.filter((candidate) => candidate !== selected),
          };
        },
      };
      return builder;
    },
  };

  getFeesForProofs(): Amount {
    return Amount.from(this.fee);
  }
}

function account(
  mint: string,
  wallet: OfflineWallet,
  proofs: readonly Proof[],
): CashuTsWalletAccount {
  return { mint, unit: 'sat', wallet, proofs };
}

function reserve(deliveryId: ProtocolId, mints = ['https://mint.example']) {
  return { deliveryId, amount: 8, unit: 'sat', mints };
}

describe('CashuTsSenderWallet', () => {
  it('uses cashu-ts offline exact selection with receiver input fees included', async () => {
    const wallet = new OfflineWallet(1);
    const store = new InMemorySenderReservationStore([
      account('https://mint.example', wallet, [proof(8, 'wrong-net'), proof(9, 'exact-net')]),
    ]);
    const adapter = new CashuTsSenderWallet({ store });

    const selected = await adapter.reserveExact(reserve(firstDelivery));

    expect(selected).toMatchObject({
      mint: 'https://mint.example',
      unit: 'sat',
      netAmount: 8,
      proofs: [{ amount: 9, secret: 'exact-net' }],
    });
    expect(wallet.calls).toBe(1);
  });

  it('atomically returns one stable reservation for concurrent duplicate calls', async () => {
    const wallet = new OfflineWallet(0);
    const store = new InMemorySenderReservationStore([
      account('https://mint.example', wallet, [proof(8, 'only-proof')]),
    ]);
    const adapter = new CashuTsSenderWallet({ store });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => adapter.reserveExact(reserve(firstDelivery))),
    );

    expect(new Set(results.map((result) => result.proofs[0]?.secret))).toEqual(
      new Set(['only-proof']),
    );
    expect(wallet.calls).toBe(1);
  });

  it('holds ambiguous proofs and releases only after terminal rejection', async () => {
    const wallet = new OfflineWallet(0);
    const store = new InMemorySenderReservationStore([
      account('https://mint.example', wallet, [proof(8, 'shared-proof')]),
    ]);
    const adapter = new CashuTsSenderWallet({ store });

    await adapter.reserveExact(reserve(firstDelivery));
    await adapter.markRecoveryRequired(firstDelivery);
    await expect(adapter.reserveExact(reserve(secondDelivery))).rejects.toThrowError(/exact/i);

    await adapter.releaseRejected(firstDelivery);
    await expect(adapter.reserveExact(reserve(secondDelivery))).resolves.toMatchObject({
      proofs: [{ secret: 'shared-proof' }],
    });
  });

  it('never releases a reservation after settlement', async () => {
    const wallet = new OfflineWallet(0);
    const store = new InMemorySenderReservationStore([
      account('https://mint.example', wallet, [proof(8, 'spent-proof')]),
    ]);
    const adapter = new CashuTsSenderWallet({ store });

    await adapter.reserveExact(reserve(firstDelivery));
    await adapter.markSettled(firstDelivery);
    await expect(adapter.releaseRejected(firstDelivery)).rejects.toThrowError(/settled/i);
    await expect(adapter.reserveExact(reserve(secondDelivery))).rejects.toThrowError(/exact/i);
  });

  it('rejects reuse of a delivery ID with different reservation parameters', async () => {
    const wallet = new OfflineWallet(0);
    const store = new InMemorySenderReservationStore([
      account('https://mint.example', wallet, [proof(8, 'bound-proof')]),
    ]);
    const adapter = new CashuTsSenderWallet({ store });

    await adapter.reserveExact(reserve(firstDelivery));
    await expect(
      adapter.reserveExact({ ...reserve(firstDelivery), amount: 7 }),
    ).rejects.toThrowError(/bound/i);
  });
});
