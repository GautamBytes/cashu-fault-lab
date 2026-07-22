import {
  computePayloadHash,
  parseProtocolId,
  serializeDeliveryPayload,
  type CashuProof,
  type DeliveryPayload,
} from '@cashu-fault-lab/delivery-core';
import {
  CryptoEnvelope,
  type MintGateway,
  type ProofVerifier,
  type SwapPlanDraft,
} from '@cashu-fault-lab/reference-receiver';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FundedCashuTsReceiverOperations } from '../src/funded-receiver-operations.js';
import {
  ResettablePostgresReceiverStore,
  migrateCashuTsReceiverDatabase,
} from '../src/postgres-receiver-store.js';

const now = 1_784_399_400;
const mintUrl = 'https://mint.example';
const paymentTarget = 'http://127.0.0.1:4101/pay';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const proofY = `02${'01'.repeat(32)}`;
const proof: CashuProof = {
  amount: 8,
  id: '00aa',
  secret: 'postgres-receiver-proof-secret',
  C: `02${'11'.repeat(32)}`,
};

class DurableVerifier implements ProofVerifier {
  async inspect(): Promise<Awaited<ReturnType<ProofVerifier['inspect']>>> {
    return {
      ys: [proofY],
      proofClaimIds: ['a'.repeat(64)],
      proofSetHash: 'b'.repeat(64),
      netAmount: 8,
    };
  }
}

class DurableMint implements MintGateway {
  async prepareSwap(
    draft: SwapPlanDraft,
  ): Promise<Awaited<ReturnType<MintGateway['prepareSwap']>>> {
    return {
      ...draft,
      serializedRequest: '{"swap":true}',
      keysetId: '00aa',
      inputFeePpk: 0,
      outputs: [{ amount: 8, id: '00aa', B_: 'B', secret: 's', blindingFactor: '0'.repeat(64) }],
      preparedAt: now,
      recovery: { nut09: true, nut19Replay: true, nut19ReplayUntil: null },
    };
  }

  async swap(): Promise<Awaited<ReturnType<MintGateway['swap']>>> {
    return { replacementPlanHash: 'c'.repeat(64), replacementProofs: ['replacement-proof'] };
  }

  async restore(): Promise<Awaited<ReturnType<MintGateway['restore']>>> {
    return { kind: 'not_found' };
  }

  async proofStates(): Promise<Awaited<ReturnType<MintGateway['proofStates']>>> {
    return ['SPENT'];
  }
}

function payload(requestId: string): DeliveryPayload {
  return {
    id: parseProtocolId(requestId),
    memo: null,
    mint: mintUrl,
    unit: 'sat',
    proofs: [proof],
    delivery: {
      version: 1,
      id: parseProtocolId(deliveryId),
      createdAt: now,
      expiresAt: now + 900,
    },
  };
}

function receiver(store: ResettablePostgresReceiverStore): FundedCashuTsReceiverOperations {
  return new FundedCashuTsReceiverOperations({
    store,
    mintUrl,
    paymentTarget,
    mint: new DurableMint(),
    verifier: new DurableVerifier(),
    now: () => now,
  });
}

describe.skipIf(process.env.CFL_POSTGRES_E2E !== '1')(
  'ResettablePostgresReceiverStore with cashu-ts receiver operations',
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
      await migrateCashuTsReceiverDatabase(pool);
    }, 120_000);

    afterAll(async () => {
      pool?.on('error', () => {});
      await pool?.end();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await container?.stop();
    }, 30_000);

    it('survives receiver operation reconstruction with T3 credit and proof evidence', async () => {
      if (pool === undefined) throw new Error('PostgreSQL pool did not start');
      const key = Buffer.alloc(32, 7);
      const firstStore = new ResettablePostgresReceiverStore({
        pool,
        envelope: new CryptoEnvelope(key),
        tenantId: 'cashu-ts-postgres-e2e',
      });
      const first = receiver(firstStore);
      await first.reset('postgres-receiver');
      const request = await first.createRequest({
        amount: 8,
        unit: 'sat',
        transports: ['http'],
        singleUse: true,
        expiresIn: 900,
      });
      const receipt = await first.receive(serializeDeliveryPayload(payload(request.id)));

      const restarted = receiver(
        new ResettablePostgresReceiverStore({
          pool,
          envelope: new CryptoEnvelope(key),
          tenantId: 'cashu-ts-postgres-e2e',
        }),
      );

      await expect(restarted.capabilities()).resolves.toMatchObject({ evidenceTier: 'T3' });
      await expect(restarted.delivery(deliveryId)).resolves.toEqual(receipt);
      await expect(restarted.ledger()).resolves.toEqual([
        {
          requestId: request.id,
          deliveryId,
          amount: 8,
          unit: 'sat',
          creditCount: 1,
          createdAt: now,
        },
      ]);
      await expect(restarted.proofs()).resolves.toEqual([
        { deliveryId, proofSetHash: 'b'.repeat(64), inputYs: [proofY], state: 'spent' },
      ]);
      expect(receipt.payload_hash).toBe(
        computePayloadHash({
          requestId: parseProtocolId(request.id),
          memo: null,
          mint: mintUrl,
          unit: 'sat',
          proofs: [proof],
          createdAt: now,
          expiresAt: now + 900,
        }),
      );
    });
  },
);
