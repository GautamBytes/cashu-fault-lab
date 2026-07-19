import { getPublicKey, nip19 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { decodeNip17Target } from '../src/index.js';

const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const receiverPublicKey = getPublicKey(receiverKey);

describe('NUT-18 NIP-17 target', () => {
  it('decodes an nprofile and validates the exact NIP-17 marker', () => {
    const target = nip19.nprofileEncode({
      pubkey: receiverPublicKey,
      relays: ['wss://relay-one.example', 'wss://relay-two.example'],
    });

    expect(decodeNip17Target(target, [['n', '17']])).toEqual({
      receiverPublicKey,
      relayUrls: ['wss://relay-one.example/', 'wss://relay-two.example/'],
    });
  });

  it('does not silently treat the NUT-26 raw public-key form as NIP-17', () => {
    expect(() => decodeNip17Target(receiverPublicKey, [['n', '17']])).toThrowError(/nprofile/i);
    const target = nip19.nprofileEncode({
      pubkey: receiverPublicKey,
      relays: ['wss://relay.example'],
    });
    expect(() => decodeNip17Target(target, [['n', '4']])).toThrowError(/NIP-17/i);
  });
});
