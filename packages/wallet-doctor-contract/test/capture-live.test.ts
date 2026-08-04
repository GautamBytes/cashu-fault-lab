import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type Event } from 'nostr-tools';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import type { MintObservation } from '@cashu-fault-lab/wallet-doctor-core';
import { captureDigest, captureWallet, validateNip60Capture } from '../src/index.js';

const MINT = 'http://127.0.0.1:3338';

function publish(relayUrl: string, event: Event): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timeout = setTimeout(() => reject(new Error('publish timed out')), 5_000);
    socket.once('open', () => socket.send(JSON.stringify(['EVENT', event])));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'OK' && message[1] === event.id) {
        clearTimeout(timeout);
        socket.close();
        if (message[2] === true) resolve();
        else reject(new Error(`relay rejected event: ${String(message[3])}`));
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

interface Fixture {
  readonly sk: Uint8Array;
  readonly pk: string;
  readonly conversationKey: Uint8Array;
  readonly tokenA: Event;
  readonly tokenB: Event;
  readonly deletion: Event;
  readonly secrets: readonly string[];
}

function makeFixture(): Fixture {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const conversationKey = nip44.v2.utils.getConversationKey(sk, pk);
  const secrets = ['proof-secret-alpha', 'proof-secret-beta'];
  const tokenPayload = (secret: string): string =>
    JSON.stringify({
      mint: MINT,
      proofs: [{ id: '00ad268c4d1f5826', amount: 4, secret }],
    });
  const tokenA = finalizeEvent(
    {
      kind: 7375,
      created_at: 1_700_000_000,
      tags: [],
      content: nip44.v2.encrypt(tokenPayload(secrets[0] ?? ''), conversationKey),
    },
    sk,
  );
  const tokenB = finalizeEvent(
    {
      kind: 7375,
      created_at: 1_700_000_100,
      tags: [],
      content: nip44.v2.encrypt(tokenPayload(secrets[1] ?? ''), conversationKey),
    },
    sk,
  );
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: 1_700_000_200,
      tags: [
        ['e', tokenA.id],
        ['k', '7375'],
      ],
      content: '',
    },
    sk,
  );
  return { sk, pk, conversationKey, tokenA, tokenB, deletion, secrets };
}

const fakeMintTruth = (mint: string, ys: readonly string[]): Promise<readonly MintObservation[]> =>
  Promise.resolve(ys.map((y) => ({ mint, y, state: 'UNSPENT' as const })));

describe('captureWallet against live in-process relays', () => {
  it('matches the committed encrypted redaction vector', async () => {
    const vectorUrl = new URL(
      '../../../spec/vectors/nip60-capture-redaction.json',
      import.meta.url,
    );
    const vector = JSON.parse(await readFile(vectorUrl, 'utf8')) as {
      testOnlySubjectSecretKeyHex: string;
      inputEvent: Event;
      expectedNormalized: unknown;
      mustNotAppearInCapture: string[];
    };
    const capture = await captureWallet({
      relays: ['wss://relay.example'],
      subjectSecretKey: Uint8Array.from(Buffer.from(vector.testOnlySubjectSecretKeyHex, 'hex')),
      capturedAt: '2026-08-04T00:00:00.000Z',
      fetchEvents: () => Promise.resolve([vector.inputEvent]),
      checkStates: fakeMintTruth,
    });
    expect(capture.observation.relays[0]?.tokens[0]).toEqual(vector.expectedNormalized);
    const serialized = JSON.stringify(capture);
    for (const forbidden of vector.mustNotAppearInCapture) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('produces the same digest when a relay returns events in a different order', async () => {
    const fixture = makeFixture();
    const options = {
      relays: ['wss://relay.example'],
      subjectSecretKey: fixture.sk,
      capturedAt: '2026-08-04T00:00:00.000Z',
      checkStates: fakeMintTruth,
    } as const;
    const forward = await captureWallet({
      ...options,
      fetchEvents: () => Promise.resolve([fixture.tokenA, fixture.tokenB, fixture.deletion]),
    });
    const reverse = await captureWallet({
      ...options,
      fetchEvents: () => Promise.resolve([fixture.deletion, fixture.tokenB, fixture.tokenA]),
    });
    expect(reverse.digest).toBe(forward.digest);
    expect(reverse.observation).toEqual(forward.observation);
  });

  it('rejects aggregate proof candidates before repeated proofs can bypass the unique-Y cap', async () => {
    const fixture = makeFixture();
    const events = Array.from({ length: 101 }, (_, eventIndex) =>
      finalizeEvent(
        {
          kind: 7375,
          created_at: 1_700_001_000 + eventIndex,
          tags: [],
          content: nip44.v2.encrypt(
            JSON.stringify({
              mint: MINT,
              proofs: Array.from({ length: 100 }, () => ({
                id: '00ad268c4d1f5826',
                amount: 1,
                secret: 'same-proof-secret',
              })),
            }),
            fixture.conversationKey,
          ),
        },
        fixture.sk,
      ),
    );
    await expect(
      captureWallet({
        relays: ['wss://relay.example'],
        subjectSecretKey: fixture.sk,
        fetchEvents: () => Promise.resolve(events),
        checkStates: fakeMintTruth,
      }),
    ).rejects.toThrow(/proof candidate count exceeds 10000/u);
  });

  it('counts repeated proof work across relay occurrences', async () => {
    const fixture = makeFixture();
    const event = finalizeEvent(
      {
        kind: 7375,
        created_at: 1_700_001_000,
        tags: [],
        content: nip44.v2.encrypt(
          JSON.stringify({
            mint: MINT,
            proofs: Array.from({ length: 200 }, (_, index) => ({
              id: '00ad268c4d1f5826',
              amount: 1,
              secret: `repeated-${index}`,
            })),
          }),
          fixture.conversationKey,
        ),
      },
      fixture.sk,
    );
    await expect(
      captureWallet({
        relays: Array.from({ length: 51 }, (_, index) => `wss://relay-${index}.example`),
        subjectSecretKey: fixture.sk,
        fetchEvents: () => Promise.resolve([event]),
        checkStates: fakeMintTruth,
      }),
    ).rejects.toThrow(/proof candidate count exceeds 10000/u);
  });

  it('collects, normalizes, redacts, and digests a divergent two-relay capture', async () => {
    const relayA = new NostrFaultRelay();
    const relayB = new NostrFaultRelay();
    const urlA = await relayA.listen(0);
    const urlB = await relayB.listen(0);
    try {
      const fixture = makeFixture();
      // Relay A holds both tokens plus the deletion for token A; relay B holds
      // only token A (partitioned history).
      await publish(urlA, fixture.tokenA);
      await publish(urlA, fixture.tokenB);
      await publish(urlA, fixture.deletion);
      await publish(urlB, fixture.tokenA);

      const capture = await captureWallet({
        relays: [urlA, urlB],
        allowInsecureLoopback: true,
        subjectSecretKey: fixture.sk,
        capturedAt: '2026-08-03T12:00:00.000Z',
        checkStates: fakeMintTruth,
      });

      expect(validateNip60Capture(capture).ok).toBe(true);
      expect(capture.observation.relays).toHaveLength(2);
      const [obsA, obsB] = capture.observation.relays;
      expect(obsA?.status).toBe('ok');
      expect(obsA?.tokens.map((token) => token.eventId).sort()).toEqual(
        [fixture.tokenA.id, fixture.tokenB.id].sort(),
      );
      expect(obsA?.deletions.map((entry) => entry.eventId)).toEqual([fixture.deletion.id]);
      expect(obsB?.tokens.map((token) => token.eventId)).toEqual([fixture.tokenA.id]);
      expect(obsB?.deletions).toEqual([]);

      // Mint truth was requested for both discovered proofs.
      expect(capture.observation.mint).toHaveLength(2);
      expect(capture.observation.mint.every((entry) => entry.state === 'UNSPENT')).toBe(true);

      // Neither plaintext secrets nor encrypted event bodies reach the bundle.
      const serialized = JSON.stringify(capture);
      for (const secret of fixture.secrets) {
        expect(serialized).not.toContain(secret);
      }
      expect(capture.redaction.proofSecretsDropped).toBe(true);
      expect(capture.redaction.encryptedContentsDropped).toBe(true);
      expect(capture.redaction.walletPrivateKeyDropped).toBe(true);
      expect(serialized).not.toContain(fixture.tokenA.content);
      expect(serialized).not.toContain(fixture.tokenA.sig);
      expect(capture.relayEvidence[0]?.eventIds).toContain(fixture.tokenA.id);

      // Digest is deterministic over the redacted bundle.
      const { digest, ...bundle } = capture;
      expect(captureDigest(bundle)).toBe(digest);
    } finally {
      await relayA.close();
      await relayB.close();
    }
  }, 20_000);

  it('records relay errors instead of failing the whole capture', async () => {
    const relayA = new NostrFaultRelay();
    const urlA = await relayA.listen(0);
    try {
      const fixture = makeFixture();
      await publish(urlA, fixture.tokenA);
      const capture = await captureWallet({
        relays: [urlA, 'ws://127.0.0.1:1'],
        allowInsecureLoopback: true,
        subjectSecretKey: fixture.sk,
        timeoutMs: 2_000,
        capturedAt: '2026-08-03T12:00:00.000Z',
        checkStates: fakeMintTruth,
      });
      expect(capture.observation.relays[0]?.status).toBe('ok');
      expect(capture.observation.relays[1]?.status).toBe('error');
      expect(capture.observation.relays[1]?.error).not.toBeNull();
    } finally {
      await relayA.close();
    }
  }, 20_000);

  it('marks encrypted events as malformed when no key is provided', async () => {
    const relayA = new NostrFaultRelay();
    const urlA = await relayA.listen(0);
    try {
      const fixture = makeFixture();
      await publish(urlA, fixture.tokenA);
      const capture = await captureWallet({
        relays: [urlA],
        allowInsecureLoopback: true,
        subjectPubkey: fixture.pk,
        timeoutMs: 2_000,
        capturedAt: '2026-08-03T12:00:00.000Z',
        checkStates: fakeMintTruth,
      });
      const obsA = capture.observation.relays[0];
      expect(obsA?.tokens).toEqual([]);
      expect(obsA?.malformed).toEqual([
        {
          eventId: fixture.tokenA.id,
          kind: 7375,
          reason: 'decryption_failed',
          seenOn: [urlA],
        },
      ]);
      // Only the event identifier is preserved as relay evidence.
      expect(capture.relayEvidence[0]?.eventIds).toEqual([fixture.tokenA.id]);
    } finally {
      await relayA.close();
    }
  }, 20_000);
});
