import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { Event } from 'nostr-tools';
import { proofY, type Nutzap, type NutzapProof } from './protocol.js';
import type { PreparedRedemption, RedemptionRecord } from './types.js';

/** Private, disposable single-wallet journal. Transactions never span network calls. */
export class Journal {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.#db
      .exec(`CREATE TABLE IF NOT EXISTS redemptions(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs(mint TEXT, y TEXT, redemption TEXT NOT NULL, PRIMARY KEY(mint,y));
      CREATE TABLE IF NOT EXISTS outputs(mint TEXT, y TEXT, redemption TEXT NOT NULL, PRIMARY KEY(mint,y));
      CREATE TABLE IF NOT EXISTS acknowledgements(id TEXT, target TEXT, PRIMARY KEY(id,target));`);
  }
  get(id: string): RedemptionRecord | undefined {
    const row = this.#db.prepare('SELECT record FROM redemptions WHERE id=?').get(id);
    if (!row) return undefined;
    const record: RedemptionRecord = JSON.parse(String(row.record));
    record.published = this.#db
      .prepare('SELECT target FROM acknowledgements WHERE id=?')
      .all(id)
      .map((r) => String(r.target));
    return record;
  }
  reserve(zap: Nutzap, plan: PreparedRedemption): RedemptionRecord {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      let record = this.get(zap.id);
      if (record) {
        if (
          record.zap.recipient !== zap.recipient ||
          record.zap.lockingKey !== zap.lockingKey ||
          record.zap.amount !== zap.amount ||
          JSON.stringify(record.zap.proofs.map((p) => [proofY(p), p.amount, p.id, p.C]).sort()) !==
            JSON.stringify(zap.proofs.map((p) => [proofY(p), p.amount, p.id, p.C]).sort())
        )
          throw new Error('Conflicting nutzap economic identity');
      } else {
        for (const p of zap.proofs)
          this.#db.prepare('INSERT INTO inputs VALUES(?,?,?)').run(zap.mint, proofY(p), zap.id);
        record = { zap, plan, credit: null, events: [], published: [] };
        this.#db.prepare('INSERT INTO redemptions VALUES(?,?)').run(zap.id, JSON.stringify(record));
      }
      this.#db.exec('COMMIT');
      return record;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  credit(
    id: string,
    amount: number,
    events: Event[],
    proofs: NutzapProof[],
    origin: 'local' | 'relay' = 'local',
  ): RedemptionRecord {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.get(id);
      if (!record) throw Error('Missing prepared nutzap');
      if (record.credit === null) {
        // A second receipt must not turn the same bearer proofs into a second balance.
        for (const proof of proofs)
          this.#db
            .prepare('INSERT INTO outputs VALUES(?,?,?)')
            .run(record.zap.mint, proofY(proof), id);
        record.credit = amount;
        record.origin = origin;
        record.events = events;
        this.#db
          .prepare('UPDATE redemptions SET record=? WHERE id=?')
          .run(JSON.stringify(record), id);
      }
      this.#db.exec('COMMIT');
      return record;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  acknowledge(id: string, target: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO acknowledgements VALUES(?,?)').run(id, target);
  }
  summary(): { credits: number; balance: number } {
    const records = this.#db
      .prepare('SELECT record FROM redemptions')
      .all()
      .map((r) => JSON.parse(String(r.record)) as RedemptionRecord);
    return {
      credits: records.filter((r) => r.credit !== null && r.origin !== 'relay').length,
      balance: records.reduce((sum, r) => sum + (r.credit ?? 0), 0),
    };
  }
  close(): void {
    this.#db.close();
  }
}
