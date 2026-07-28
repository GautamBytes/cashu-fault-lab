import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import type { ProofEvidenceView } from '@cashu-fault-lab/adapter-contract';
import {
  computePayloadHash,
  parseDeliveryPayloadJson,
  type CashuProof,
} from '@cashu-fault-lab/delivery-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FundedCashuTsOperations,
  type CashuTsTransportPort,
  type CashuTsWalletPort,
  type ReservedCashuTsProofs,
} from '../src/funded-operations.js';
import {
  PostgresCashuTsSenderStore,
  migratePostgresCashuTsSenderStore,
  parseCashuTsSenderStateKeys,
} from '../src/postgres-sender-store.js';

const keyOne = Buffer.alloc(32, 1).toString('base64url');
const keyTwo = Buffer.alloc(32, 2).toString('base64url');
const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const proof: CashuProof = {
  amount: 8,
  id: '00aa',
  secret: 'postgres-sender-proof-secret',
  C: `02${'11'.repeat(32)}`,
};

function encodedRequest(): string {
  return new PaymentRequest(
    [{ type: PaymentRequestTransportType.POST, target: 'http://127.0.0.1:8181/pay' }],
    requestId,
    8,
    'sat',
    ['https://mint.example'],
    'order-42',
    true,
  ).toEncodedCreqA();
}

class Wallet implements CashuTsWalletPort {
  reserveCalls = 0;

  async reset(): Promise<void> {
    this.reserveCalls = 0;
  }

  async reserve(): Promise<ReservedCashuTsProofs> {
    this.reserveCalls += 1;
    return { mint: 'https://mint.example', proofs: [proof] };
  }

  async markSettled(): Promise<void> {}

  async evidence(selectedDeliveryId: string): Promise<ProofEvidenceView> {
    return {
      deliveryId: selectedDeliveryId,
      proofSetHash: 'b'.repeat(64),
      inputYs: [`02${'01'.repeat(32)}`],
      state: 'pending',
    };
  }
}

class ReplacementWallet implements CashuTsWalletPort {
  async reset(): Promise<void> {
    throw new Error('replacement sender must not reset the wallet');
  }

  async reserve(): Promise<ReservedCashuTsProofs> {
    throw new Error('replacement sender must not reserve proofs');
  }

  async markSettled(): Promise<void> {
    throw new Error('replacement sender must not need process-local proof reservation state');
  }

  async evidence(): Promise<ProofEvidenceView> {
    throw new Error('replacement sender must use persisted proof evidence');
  }
}

class Transport implements CashuTsTransportPort {
  readonly bodies: Uint8Array[] = [];
  loseFirstResponse = false;

  async send(
    _target: { readonly type: 'post' | 'nostr'; readonly target: string },
    body: Uint8Array,
  ) {
    this.bodies.push(Uint8Array.from(body));
    const payload = parseDeliveryPayloadJson(body, now);
    if (this.loseFirstResponse && this.bodies.length === 1) {
      throw new Error('receiver accepted but response was lost');
    }
    return {
      profile: 'cashu-delivery-v1' as const,
      request_id: payload.id,
      delivery_id: payload.delivery.id,
      payload_hash: computePayloadHash({
        requestId: payload.id,
        memo: payload.memo,
        mint: payload.mint,
        unit: payload.unit,
        proofs: payload.proofs,
        createdAt: payload.delivery.createdAt,
        expiresAt: payload.delivery.expiresAt,
      }),
      status: 'settled' as const,
      status_version: 2,
      mint: payload.mint,
      unit: payload.unit,
      amount: 8,
      detail_code: 'settled',
    };
  }
}

describe('parseCashuTsSenderStateKeys', () => {
  it('parses an active key version and readable rotation map', () => {
    const ring = parseCashuTsSenderStateKeys({
      activeKeyVersion: 2,
      encodedKeys: `1:${keyOne},2:${keyTwo}`,
    });

    expect(ring.activeKeyVersion).toBe(2);
    expect(ring.keys.get(1)).toEqual(Buffer.alloc(32, 1));
    expect(ring.keys.get(2)).toEqual(Buffer.alloc(32, 2));
  });

  it('rejects duplicate, missing-active, malformed, and non-32-byte key entries', () => {
    expect(() =>
      parseCashuTsSenderStateKeys({
        activeKeyVersion: 1,
        encodedKeys: `1:${keyOne},1:${keyTwo}`,
      }),
    ).toThrowError(/duplicate/i);
    expect(() =>
      parseCashuTsSenderStateKeys({
        activeKeyVersion: 3,
        encodedKeys: `1:${keyOne},2:${keyTwo}`,
      }),
    ).toThrowError(/active/i);
    expect(() =>
      parseCashuTsSenderStateKeys({ activeKeyVersion: 1, encodedKeys: 'not-a-key' }),
    ).toThrowError(/malformed/i);
    expect(() =>
      parseCashuTsSenderStateKeys({
        activeKeyVersion: 1,
        encodedKeys: `1:${Buffer.alloc(31, 1).toString('base64url')}`,
      }),
    ).toThrowError(/32 bytes/i);
  });
});

describe.skipIf(process.env.CFL_POSTGRES_E2E !== '1')(
  'PostgresCashuTsSenderStore with cashu-ts sender operations',
  () => {
    let container: StartedPostgreSqlContainer | undefined;
    let pool: Pool | undefined;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:18-alpine')
        .withDatabase('cashu_fault_lab')
        .withUsername('cashu')
        .withPassword('cashu-test-password')
        .start();
      pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
      await migratePostgresCashuTsSenderStore(pool);
    }, 120_000);

    afterAll(async () => {
      pool?.on('error', () => {});
      await pool?.end();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await container?.stop();
    }, 30_000);

    it('replays persisted bytes after process replacement without a new reservation', async () => {
      if (pool === undefined) throw new Error('PostgreSQL pool did not start');
      const keyRing = parseCashuTsSenderStateKeys({
        activeKeyVersion: 1,
        encodedKeys: `1:${Buffer.alloc(32, 8).toString('base64url')}`,
      });
      const firstStore = new PostgresCashuTsSenderStore({
        pool,
        keyRing,
        runId: 'sender-e2e',
        tenantId: 'cashu-ts-postgres-sender-e2e',
      });
      const wallet = new Wallet();
      const firstTransport = new Transport();
      firstTransport.loseFirstResponse = true;
      const first = new FundedCashuTsOperations({
        wallet,
        transport: firstTransport,
        store: firstStore,
        now: () => now,
      });

      await first.reset('postgres-sender');
      await expect(first.send({ request: encodedRequest(), deliveryId })).rejects.toThrow(
        'Cashu payment delivery failed',
      );

      const replacementTransport = new Transport();
      const replacement = new FundedCashuTsOperations({
        wallet: new ReplacementWallet(),
        transport: replacementTransport,
        store: new PostgresCashuTsSenderStore({
          pool,
          keyRing,
          runId: 'sender-e2e',
          tenantId: 'cashu-ts-postgres-sender-e2e',
        }),
        now: () => now,
      });

      await expect(replacement.capabilities()).resolves.toMatchObject({
        roles: { sender: { durability: 'persistent' } },
      });
      await expect(
        replacement.send({ request: encodedRequest(), deliveryId }),
      ).resolves.toMatchObject({ status: 'settled' });
      await expect(replacement.proofs()).resolves.toEqual([
        expect.objectContaining({ deliveryId, state: 'spent' }),
      ]);
      expect(wallet.reserveCalls).toBe(1);
      expect(replacementTransport.bodies).toHaveLength(1);
      expect(Buffer.compare(firstTransport.bodies[0]!, replacementTransport.bodies[0]!)).toBe(0);
    });

    it('persists a proof reservation before the reservation crash boundary', async () => {
      if (pool === undefined) throw new Error('PostgreSQL pool did not start');
      const keyRing = parseCashuTsSenderStateKeys({
        activeKeyVersion: 1,
        encodedKeys: `1:${Buffer.alloc(32, 7).toString('base64url')}`,
      });
      const store = new PostgresCashuTsSenderStore({
        pool,
        keyRing,
        runId: 'sender-reservation-crash',
        tenantId: 'cashu-ts-postgres-reservation-e2e',
      });
      const wallet = new Wallet();
      let crashed = false;
      const first = new FundedCashuTsOperations({
        wallet,
        transport: new Transport(),
        store,
        crashCheckpoint: {
          async hit(boundary): Promise<void> {
            if (
              boundary === 'sender_after_reservation_before_payload_persistence' &&
              !crashed
            ) {
              crashed = true;
              throw new Error('simulated process crash');
            }
          },
        },
        now: () => now,
      });
      await first.reset('reservation-crash');
      await expect(
        first.send({ request: encodedRequest(), deliveryId }),
      ).rejects.toThrow('simulated process crash');

      const replacementTransport = new Transport();
      const replacement = new FundedCashuTsOperations({
        wallet: new ReplacementWallet(),
        transport: replacementTransport,
        store: new PostgresCashuTsSenderStore({
          pool,
          keyRing,
          runId: 'sender-reservation-crash',
          tenantId: 'cashu-ts-postgres-reservation-e2e',
        }),
        now: () => now,
      });
      await expect(
        replacement.send({ request: encodedRequest(), deliveryId }),
      ).resolves.toMatchObject({ status: 'settled' });
      expect(wallet.reserveCalls).toBe(1);
      expect(replacementTransport.bodies).toHaveLength(1);
    });
  },
);
