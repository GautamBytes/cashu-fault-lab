import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import { loopbackMint } from './protocol.js';

interface Entry {
  info: Event;
  secret: string | null;
}
function profile(info: Event, recipient: string): { lockingKey: string; mint: string } {
  if (
    Buffer.byteLength(JSON.stringify(info)) > 65536 ||
    !verifyEvent(JSON.parse(JSON.stringify(info))) ||
    info.kind !== 10019 ||
    info.pubkey !== recipient ||
    !Number.isSafeInteger(info.created_at) ||
    info.created_at < 0
  )
    throw Error('Invalid receiving-key advertisement');
  const keys = info.tags.filter((t) => t[0] === 'pubkey');
  const mints = info.tags.filter((t) => t[0] === 'mint');
  const lockingKey = keys[0]?.[1];
  if (
    keys.length !== 1 ||
    keys[0]?.length !== 2 ||
    !lockingKey ||
    !/^[0-9a-f]{64}$/u.test(lockingKey) ||
    lockingKey === recipient ||
    mints.length !== 1 ||
    !mints[0]?.[1] ||
    !(mints[0].length === 2 || (mints[0].length === 3 && mints[0][2] === 'sat'))
  )
    throw Error('Unsupported receiving-key profile');
  return { lockingKey, mint: loopbackMint(mints[0][1]) };
}
function newest(a: Event, b: Event): Event {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id) ? a : b;
}
/** One rotation, one unchanged mint. Private lab state, not a NIP-60 wire format. */
export class ReceivingKeys {
  readonly #db: DatabaseSync;
  constructor(
    path: string,
    readonly recipient: string,
  ) {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS receiving_keys(pubkey TEXT PRIMARY KEY, info TEXT NOT NULL, secret TEXT);`);
  }
  entries(): Entry[] {
    return this.#db
      .prepare('SELECT info,secret FROM receiving_keys')
      .all()
      .map((row) => ({
        info: JSON.parse(String(row.info)) as Event,
        secret: row.secret === null ? null : String(row.secret),
      }));
  }
  current(): Event {
    const entries = this.entries();
    if (!entries.length) throw Error('Missing receiving-key advertisement');
    return entries.map((e) => e.info).reduce(newest);
  }
  remember(info: Event, secret?: string): void {
    const candidate = profile(info, this.recipient);
    if (
      secret !== undefined &&
      (!/^[0-9a-f]{64}$/u.test(secret) ||
        getPublicKey(Uint8Array.from(Buffer.from(secret, 'hex'))) !== candidate.lockingKey)
    )
      throw Error('Receiving secret does not match advertised key');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const entries = this.entries();
      let existing: Entry | undefined;
      for (const entry of entries) {
        const known = profile(entry.info, this.recipient);
        if (known.mint !== candidate.mint) throw Error('Rotation cannot change mint trust');
        if (known.lockingKey === candidate.lockingKey) existing = entry;
      }
      if (!existing && entries.length >= 2)
        throw Error('Only one receiving-key rotation supported');
      const selected = existing ? newest(existing.info, info) : info;
      this.#db
        .prepare(
          `INSERT INTO receiving_keys VALUES(?,?,?)
        ON CONFLICT(pubkey) DO UPDATE SET info=excluded.info,secret=excluded.secret`,
        )
        .run(candidate.lockingKey, JSON.stringify(selected), secret ?? existing?.secret ?? null);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.#db.close();
  }
}
