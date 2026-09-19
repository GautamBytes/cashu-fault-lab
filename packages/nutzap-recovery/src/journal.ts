import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { Event } from 'nostr-tools';
import { proofY, type Nutzap, type NutzapProof } from './protocol.js';
import type { PreparedRedemption, PreparedSpend, RedemptionRecord } from './types.js';

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
        record.wallet = { token: events.find((e) => e.kind === 7375) ?? null, proofs, retired: [] };
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
  #update(id: string, change: (record: RedemptionRecord) => void): RedemptionRecord {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.get(id);
      if (!record || record.credit === null) throw Error('Missing credited nutzap');
      change(record);
      this.#db
        .prepare('UPDATE redemptions SET record=? WHERE id=?')
        .run(JSON.stringify(record), id);
      this.#db.exec('COMMIT');
      return record;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  prepareSpend(id: string, amount: number, plan: PreparedSpend): RedemptionRecord {
    return this.#update(id, (record) => {
      if (record.spend) {
        if (record.spend.amount !== amount) throw Error('Conflicting spend amount');
        return;
      }
      if (!record.wallet?.token || record.wallet.retired.length)
        throw Error('Requires initial wallet token');
      record.spend = { amount, plan, events: [], sent: [] };
      // Prepared inputs are reserved, never advertised as spendable during recovery.
      record.wallet.proofs = [];
    });
  }
  #wallet(
    record: RedemptionRecord,
    token: Event | null,
    proofs: NutzapProof[],
    retired: string[],
  ): void {
    const tombstones = [...new Set([...(record.wallet?.retired ?? []), ...retired])];
    if (token && tombstones.includes(token.id)) throw Error('Retired wallet token');
    for (const proof of proofs) {
      const owner = this.#db
        .prepare('SELECT redemption FROM outputs WHERE mint=? AND y=?')
        .get(record.zap.mint, proofY(proof));
      if (owner && owner.redemption !== record.zap.id)
        throw Error('Proof already belongs to another receipt');
      this.#db
        .prepare('INSERT OR IGNORE INTO outputs VALUES(?,?,?)')
        .run(record.zap.mint, proofY(proof), record.zap.id);
    }
    record.wallet = { token, proofs, retired: tombstones };
  }
  wallet(id: string, token: Event | null, proofs: NutzapProof[], retired: string[]): boolean {
    let updated = false;
    this.#update(id, (record) => {
      if (record.spend && !record.spend.events.length) return;
      this.#wallet(record, token, proofs, retired);
      updated = true;
    });
    return updated;
  }
  finishSpend(
    id: string,
    events: Event[],
    keep: NutzapProof[],
    sent: NutzapProof[],
  ): RedemptionRecord {
    return this.#update(id, (record) => {
      if (!record.spend) throw Error('Missing prepared spend');
      if (record.spend.events.length) return;
      const original = record.events.find((e) => e.kind === 7375)!;
      this.#wallet(
        record,
        events.find((e) => e.kind === 7375)!,
        keep,
        [original.id],
      );
      record.spend.events = events;
      record.spend.sent = sent;
    });
  }
  summary(): { credits: number; balance: number } {
    const records = this.#db
      .prepare('SELECT record FROM redemptions')
      .all()
      .map((r) => JSON.parse(String(r.record)) as RedemptionRecord);
    return {
      credits: records.filter((r) => r.credit !== null && r.origin !== 'relay').length,
      balance: records.reduce(
        (sum, r) =>
          sum + (r.wallet ? r.wallet.proofs.reduce((n, p) => n + p.amount, 0) : (r.credit ?? 0)),
        0,
      ),
    };
  }
  close(): void {
    this.#db.close();
  }
}
