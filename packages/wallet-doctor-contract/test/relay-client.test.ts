import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { isNip60EventForSubject, selectNip60Relays } from '../src/index.js';

describe('isNip60EventForSubject', () => {
  it('binds valid signed evidence to the requested author and allowed kinds', () => {
    const subjectKey = generateSecretKey();
    const otherKey = generateSecretKey();
    const subject = getPublicKey(subjectKey);
    const valid = finalizeEvent(
      { kind: 7375, created_at: 1_700_000_000, tags: [], content: 'ciphertext' },
      subjectKey,
    );
    const wrongAuthor = finalizeEvent(
      { kind: 7375, created_at: 1_700_000_000, tags: [], content: 'ciphertext' },
      otherKey,
    );
    const wrongKind = finalizeEvent(
      { kind: 1, created_at: 1_700_000_000, tags: [], content: 'hello' },
      subjectKey,
    );

    expect(isNip60EventForSubject(valid, subject)).toBe(true);
    expect(isNip60EventForSubject(wrongAuthor, subject)).toBe(false);
    expect(isNip60EventForSubject(wrongKind, subject)).toBe(false);
  });
});

describe('selectNip60Relays', () => {
  it('uses the latest kind 10019 relay tags before NIP-65 fallback', () => {
    const key = generateSecretKey();
    const old = finalizeEvent(
      {
        kind: 10019,
        created_at: 10,
        tags: [['relay', 'wss://old.example']],
        content: '',
      },
      key,
    );
    const latest = finalizeEvent(
      {
        kind: 10019,
        created_at: 20,
        tags: [
          ['relay', 'wss://wallet-b.example'],
          ['relay', 'wss://wallet-a.example'],
        ],
        content: '',
      },
      key,
    );
    const nip65 = finalizeEvent(
      {
        kind: 10002,
        created_at: 30,
        tags: [['r', 'wss://fallback.example', 'write']],
        content: '',
      },
      key,
    );
    expect(selectNip60Relays([old, nip65, latest])).toEqual([
      'wss://wallet-a.example',
      'wss://wallet-b.example',
    ]);
  });

  it('falls back to latest NIP-65 write and bidirectional relays', () => {
    const key = generateSecretKey();
    const nip65 = finalizeEvent(
      {
        kind: 10002,
        created_at: 30,
        tags: [
          ['r', 'wss://both.example'],
          ['r', 'wss://write.example', 'write'],
          ['r', 'wss://read-only.example', 'read'],
          ['r', 'https://not-a-relay.example'],
        ],
        content: '',
      },
      key,
    );
    expect(selectNip60Relays([nip65])).toEqual(['wss://both.example', 'wss://write.example']);
  });

  it('uses the lowest event id to break equal-timestamp replaceable-event ties', () => {
    const key = generateSecretKey();
    const first = finalizeEvent(
      { kind: 10019, created_at: 30, tags: [['relay', 'wss://first.example']], content: '' },
      key,
    );
    const second = finalizeEvent(
      { kind: 10019, created_at: 30, tags: [['relay', 'wss://second.example']], content: '' },
      key,
    );
    const lowest = first.id.localeCompare(second.id) < 0 ? first : second;
    const expected = lowest === first ? 'wss://first.example' : 'wss://second.example';
    expect(selectNip60Relays([first, second])).toEqual([expected]);
  });
});
