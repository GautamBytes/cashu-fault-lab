use super::{Record, Result};
use cdk::nuts::Proof;
use nostr::prelude::Event;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs::OpenOptions,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};

/// Private disposable journal. All economic changes are single SQLite transactions.
pub struct Journal(Connection);
impl Journal {
    pub fn open(path: &Path) -> Result<Self> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)
            .map_err(|_| "journal_open_failed")?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "journal_permissions_failed")?;
        let db = Connection::open(path).map_err(|_| "journal_open_failed")?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|_| "journal_setup_failed")?;
        db.execute_batch("PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS redemptions(id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inputs(mint TEXT NOT NULL,y TEXT NOT NULL,redemption TEXT NOT NULL,PRIMARY KEY(mint,y));
            CREATE TABLE IF NOT EXISTS outputs(mint TEXT NOT NULL,y TEXT NOT NULL,redemption TEXT NOT NULL,PRIMARY KEY(mint,y));
            CREATE TABLE IF NOT EXISTS acknowledgements(id TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(id,target));").map_err(|_| "journal_setup_failed")?;
        Ok(Self(db))
    }
    pub fn get(&self, id: &str) -> Result<Option<Record>> {
        let value: Option<String> = self
            .0
            .query_row("SELECT record FROM redemptions WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| "journal_read_failed")?;
        value
            .map(|v| serde_json::from_str(&v).map_err(|_| "invalid_journal"))
            .transpose()
    }
    pub fn reserve(&mut self, record: &Record) -> Result<Record> {
        let tx = self
            .0
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "journal_busy")?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT record FROM redemptions WHERE id=?",
                [&record.zap.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "journal_read_failed")?;
        let saved = if let Some(value) = existing {
            let saved: Record = serde_json::from_str(&value).map_err(|_| "invalid_journal")?;
            if saved.zap.event.id != record.zap.event.id
                || saved.zap.mint != record.zap.mint
                || saved.zap.recipient != record.zap.recipient
            {
                return Err("conflicting_nutzap");
            }
            saved
        } else {
            for proof in &record.zap.proofs {
                tx.execute(
                    "INSERT INTO inputs VALUES(?,?,?)",
                    params![
                        record.zap.mint,
                        proof.y().map_err(|_| "invalid_proof")?.to_string(),
                        record.zap.id
                    ],
                )
                .map_err(|_| "duplicate_input")?;
            }
            tx.execute(
                "INSERT INTO redemptions VALUES(?,?)",
                params![
                    record.zap.id,
                    serde_json::to_string(record).map_err(|_| "invalid_journal")?
                ],
            )
            .map_err(|_| "journal_write_failed")?;
            record.clone()
        };
        tx.commit().map_err(|_| "journal_commit_failed")?;
        Ok(saved)
    }
    pub fn credit(
        &mut self,
        record: &Record,
        proofs: &[Proof],
        events: Vec<Event>,
        origin: &str,
    ) -> Result<Record> {
        let tx = self
            .0
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "journal_busy")?;
        let value: String = tx
            .query_row(
                "SELECT record FROM redemptions WHERE id=?",
                [&record.zap.id],
                |r| r.get(0),
            )
            .map_err(|_| "journal_read_failed")?;
        let mut saved: Record = serde_json::from_str(&value).map_err(|_| "invalid_journal")?;
        if saved.credit.is_none() {
            for proof in proofs {
                tx.execute(
                    "INSERT INTO outputs VALUES(?,?,?)",
                    params![
                        record.zap.mint,
                        proof.y().map_err(|_| "invalid_proof")?.to_string(),
                        record.zap.id
                    ],
                )
                .map_err(|_| "duplicate_output")?;
            }
            let value = super::protocol::amount(proofs)?;
            if value.checked_add(saved.plan.fee) != Some(saved.zap.amount) {
                return Err("value_mismatch");
            }
            saved.credit = Some(value);
            saved.events = events;
            saved.origin = Some(origin.to_owned());
            tx.execute(
                "UPDATE redemptions SET record=? WHERE id=?",
                params![
                    serde_json::to_string(&saved).map_err(|_| "invalid_journal")?,
                    record.zap.id
                ],
            )
            .map_err(|_| "journal_write_failed")?;
        }
        tx.commit().map_err(|_| "journal_commit_failed")?;
        Ok(saved)
    }
    pub fn acknowledged(&self, id: &str, target: &str) -> Result<bool> {
        self.0
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM acknowledgements WHERE id=? AND target=?)",
                params![id, target],
                |r| r.get(0),
            )
            .map_err(|_| "journal_read_failed")
    }
    pub fn acknowledge(&self, id: &str, target: &str) -> Result<()> {
        self.0
            .execute(
                "INSERT OR IGNORE INTO acknowledgements VALUES(?,?)",
                params![id, target],
            )
            .map_err(|_| "journal_write_failed")?;
        Ok(())
    }
}
