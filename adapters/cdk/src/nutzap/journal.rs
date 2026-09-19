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
            saved.wallet = Some(super::Wallet {
                token: events.iter().find(|e| e.kind.as_u16() == 7375).cloned(),
                proofs: proofs.to_vec(),
                retired: vec![],
            });
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
    fn update(
        &mut self,
        id: &str,
        change: impl FnOnce(&rusqlite::Transaction<'_>, &mut Record) -> Result<()>,
    ) -> Result<Record> {
        let tx = self
            .0
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "journal_busy")?;
        let value: String = tx
            .query_row("SELECT record FROM redemptions WHERE id=?", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "missing_receipt")?;
        let mut record: Record = serde_json::from_str(&value).map_err(|_| "invalid_journal")?;
        if record.credit.is_none() {
            return Err("missing_credit");
        }
        change(&tx, &mut record)?;
        tx.execute(
            "UPDATE redemptions SET record=? WHERE id=?",
            params![
                serde_json::to_string(&record).map_err(|_| "invalid_journal")?,
                id
            ],
        )
        .map_err(|_| "journal_write_failed")?;
        tx.commit().map_err(|_| "journal_commit_failed")?;
        Ok(record)
    }
    pub fn prepare_spend(
        &mut self,
        id: &str,
        amount: u64,
        plan: super::SpendPlan,
    ) -> Result<Record> {
        self.update(id, |_, record| {
            if let Some(spend) = &record.spend {
                return if spend.amount == amount {
                    Ok(())
                } else {
                    Err("conflicting_spend")
                };
            }
            let wallet = record.wallet.as_mut().ok_or("missing_wallet")?;
            if wallet.token.is_none() || !wallet.retired.is_empty() || wallet.proofs.is_empty() {
                return Err("requires_initial_wallet");
            }
            record.spend = Some(super::Spend {
                amount,
                plan,
                events: vec![],
                sent: vec![],
            });
            wallet.proofs.clear();
            Ok(())
        })
    }
    fn set_wallet(
        tx: &rusqlite::Transaction<'_>,
        record: &mut Record,
        token: Option<Event>,
        proofs: Vec<Proof>,
        retired: Vec<String>,
    ) -> Result<()> {
        let mut tombstones: std::collections::BTreeSet<String> = record
            .wallet
            .as_ref()
            .map(|w| w.retired.clone())
            .unwrap_or_default()
            .into_iter()
            .collect();
        tombstones.extend(retired);
        if token
            .as_ref()
            .is_some_and(|e| tombstones.contains(&e.id.to_hex()))
        {
            return Err("retired_token");
        }
        for proof in &proofs {
            let y = proof.y().map_err(|_| "invalid_proof")?.to_string();
            let owner: Option<String> = tx
                .query_row(
                    "SELECT redemption FROM outputs WHERE mint=? AND y=?",
                    params![record.zap.mint, y],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| "journal_read_failed")?;
            if owner.is_some_and(|o| o != record.zap.id) {
                return Err("duplicate_output");
            }
            tx.execute(
                "INSERT OR IGNORE INTO outputs VALUES(?,?,?)",
                params![record.zap.mint, y, record.zap.id],
            )
            .map_err(|_| "journal_write_failed")?;
        }
        record.wallet = Some(super::Wallet {
            token,
            proofs,
            retired: tombstones.into_iter().collect(),
        });
        Ok(())
    }
    pub fn wallet(
        &mut self,
        id: &str,
        token: Option<Event>,
        proofs: Vec<Proof>,
        retired: Vec<String>,
    ) -> Result<bool> {
        let mut updated = false;
        self.update(id, |tx, record| {
            // Re-read under the write transaction: a spend may have begun during relay/mint I/O.
            if record.spend.as_ref().is_some_and(|s| s.events.is_empty()) {
                return Ok(());
            }
            Self::set_wallet(tx, record, token, proofs, retired)?;
            updated = true;
            Ok(())
        })?;
        Ok(updated)
    }
    pub fn finish_spend(
        &mut self,
        id: &str,
        events: Vec<Event>,
        keep: Vec<Proof>,
        sent: Vec<Proof>,
    ) -> Result<Record> {
        self.update(id, |tx, record| {
            let spend = record.spend.as_ref().ok_or("missing_spend")?;
            if !spend.events.is_empty() {
                return Ok(());
            }
            let original = record
                .events
                .iter()
                .find(|e| e.kind.as_u16() == 7375)
                .ok_or("missing_token")?
                .id
                .to_hex();
            let token = events
                .iter()
                .find(|e| e.kind.as_u16() == 7375)
                .cloned()
                .ok_or("missing_token")?;
            Self::set_wallet(tx, record, Some(token), keep, vec![original])?;
            let spend = record.spend.as_mut().ok_or("missing_spend")?;
            spend.events = events;
            spend.sent = sent;
            Ok(())
        })
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
