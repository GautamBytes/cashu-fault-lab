use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use bitcoin::hashes::{Hash, sha256};
use rusqlite::{Connection, OptionalExtension, params};

use crate::lifecycle::{
    LifecycleEvidence, LifecycleInput, LifecycleOperation, LifecycleSendHandoff,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedSendHandoff {
    pub operation_id: String,
    pub recipient: String,
    pub token: String,
    pub token_hash: String,
    pub claim_token: u64,
}

/// SQLCipher-backed lifecycle journal. Secret request material, quote IDs, and tokens are only
/// present inside the encrypted database and are never projected into evidence. Raw seeds are not
/// persisted at all.
pub struct LifecycleStore {
    connection: Mutex<Connection>,
    claim_owner: String,
    clock: Arc<dyn LifecycleClock>,
}

const CLAIM_LEASE_SECONDS: u64 = 120;

pub trait LifecycleClock: Send + Sync {
    fn now(&self) -> Result<u64, String>;
}

struct SystemClock;

impl LifecycleClock for SystemClock {
    fn now(&self) -> Result<u64, String> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .map_err(|_| "system clock is invalid".to_owned())
    }
}

impl LifecycleStore {
    pub fn open(path: impl AsRef<Path>, key: [u8; 32]) -> Result<Self, String> {
        Self::open_with_clock(path, key, Arc::new(SystemClock))
    }

    pub fn open_with_clock(
        path: impl AsRef<Path>,
        key: [u8; 32],
        clock: Arc<dyn LifecycleClock>,
    ) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|_| "lifecycle database open failed")?;
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
                hex::encode(key)
            ))
            .map_err(|_| "lifecycle database encryption failed")?;
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS lifecycle_metadata (
                   name TEXT PRIMARY KEY,
                   value BLOB NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS lifecycle_operations (
                   operation_id TEXT PRIMARY KEY,
                   intent_hash TEXT NOT NULL,
                   input BLOB NOT NULL,
                   operation BLOB NOT NULL,
                   private_material BLOB,
                   claimed_until INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS lifecycle_evidence (
                   effect_id TEXT PRIMARY KEY,
                   sequence INTEGER NOT NULL UNIQUE,
                   value BLOB NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS lifecycle_send_outbox (
                   operation_id TEXT PRIMARY KEY,
                   recipient TEXT NOT NULL,
                   token BLOB NOT NULL,
                   token_hash TEXT NOT NULL,
                   claimed_by TEXT,
                   claimed_until INTEGER NOT NULL DEFAULT 0,
                   claim_token INTEGER NOT NULL DEFAULT 0,
                   acknowledged INTEGER NOT NULL DEFAULT 0,
                   FOREIGN KEY(operation_id) REFERENCES lifecycle_operations(operation_id)
                     ON DELETE CASCADE
                 );
                 COMMIT;",
            )
            .map_err(|_| "lifecycle database migration failed")?;
        let has_claim_owner = {
            let mut statement = connection
                .prepare("PRAGMA table_info(lifecycle_operations)")
                .map_err(|_| "lifecycle claim migration failed")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|_| "lifecycle claim migration failed")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "lifecycle claim migration failed")?
                .iter()
                .any(|column| column == "claim_owner")
        };
        if !has_claim_owner {
            connection
                .execute(
                    "ALTER TABLE lifecycle_operations ADD COLUMN claim_owner TEXT",
                    [],
                )
                .map_err(|_| "lifecycle claim migration failed")?;
        }
        let has_claim_token = {
            let mut statement = connection
                .prepare("PRAGMA table_info(lifecycle_operations)")
                .map_err(|_| "lifecycle claim migration failed")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|_| "lifecycle claim migration failed")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "lifecycle claim migration failed")?
                .iter()
                .any(|column| column == "claim_token")
        };
        if !has_claim_token {
            connection
                .execute(
                    "ALTER TABLE lifecycle_operations ADD COLUMN claim_token INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(|_| "lifecycle claim migration failed")?;
        }
        if !table_has_column(&connection, "lifecycle_send_outbox", "claimed_until")? {
            connection
                .execute(
                    "ALTER TABLE lifecycle_send_outbox ADD COLUMN claimed_until INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(|_| "lifecycle send handoff migration failed")?;
        }
        if !table_has_column(&connection, "lifecycle_send_outbox", "claim_token")? {
            connection
                .execute(
                    "ALTER TABLE lifecycle_send_outbox ADD COLUMN claim_token INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(|_| "lifecycle send handoff migration failed")?;
        }
        connection
            .execute("DELETE FROM lifecycle_metadata WHERE name = 'seed'", [])
            .map_err(|_| "legacy lifecycle seed removal failed")?;
        let mut owner = [0_u8; 16];
        getrandom::fill(&mut owner).map_err(|_| "lifecycle claim owner generation failed")?;
        Ok(Self {
            connection: Mutex::new(connection),
            claim_owner: hex::encode(owner),
            clock,
        })
    }

    pub fn reset(&self, seed: &str, generation: u64, token: u64) -> Result<(), String> {
        if seed.is_empty() || seed.chars().count() > 256 {
            return Err("lifecycle seed is invalid".to_owned());
        }
        let seed_hash = lifecycle_seed_hash(seed);
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle reset transaction failed")?;
        require_reset_claim(&transaction, &self.claim_owner, token, now)?;
        transaction
            .execute("DELETE FROM lifecycle_send_outbox", [])
            .and_then(|_| transaction.execute("DELETE FROM lifecycle_evidence", []))
            .and_then(|_| transaction.execute("DELETE FROM lifecycle_operations", []))
            .and_then(|_| {
                transaction.execute(
                    "INSERT INTO lifecycle_metadata(name, value) VALUES ('seed_hash', ?1)
                     ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                    [seed_hash.as_bytes()],
                )
            })
            .and_then(|_| {
                transaction.execute(
                    "INSERT INTO lifecycle_metadata(name, value) VALUES ('active_generation', ?1)
                     ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                    [generation.to_string().as_bytes()],
                )
            })
            .map_err(|_| "lifecycle reset failed")?;
        transaction
            .commit()
            .map_err(|_| "lifecycle reset commit failed")?;
        Ok(())
    }

    pub fn active_generation(&self) -> Result<u64, String> {
        let connection = self.lock()?;
        metadata_u64(&connection, "active_generation").map(|value| value.unwrap_or(0))
    }

    pub fn next_generation(&self, token: u64) -> Result<u64, String> {
        let now = self.clock.now()?;
        let connection = self.lock()?;
        require_reset_claim(&connection, &self.claim_owner, token, now)?;
        metadata_u64(&connection, "active_generation")?
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| "lifecycle wallet generation exhausted".to_owned())
    }

    pub fn seed_hash(&self) -> Result<Option<String>, String> {
        let connection = self.lock()?;
        let value: Option<Vec<u8>> = connection
            .query_row(
                "SELECT value FROM lifecycle_metadata WHERE name = 'seed_hash'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle seed hash lookup failed")?;
        value
            .map(|bytes| {
                String::from_utf8(bytes).map_err(|_| "lifecycle seed hash is corrupt".to_owned())
            })
            .transpose()
    }

    pub fn verify_seed(&self, seed: &str) -> Result<bool, String> {
        Ok(self
            .seed_hash()?
            .is_some_and(|expected| expected == lifecycle_seed_hash(seed)))
    }

    pub fn create_and_claim(
        &self,
        input: &LifecycleInput,
        operation: &LifecycleOperation,
    ) -> Result<Option<(LifecycleOperation, u64)>, String> {
        let input_json =
            serde_json::to_vec(input).map_err(|_| "lifecycle input encoding failed")?;
        let operation_json =
            serde_json::to_vec(operation).map_err(|_| "lifecycle operation encoding failed")?;
        let now = self.clock.now()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle operation create transaction failed")?;
        if reset_claim_active(&transaction, now)? {
            return Ok(None);
        }
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO lifecycle_operations
                 (operation_id, intent_hash, input, operation) VALUES (?1, ?2, ?3, ?4)",
                params![
                    operation.operation_id,
                    operation.intent_hash,
                    input_json,
                    operation_json
                ],
            )
            .map_err(|_| "lifecycle operation persistence failed")?;
        let existing = self.get_with_connection(&transaction, &operation.operation_id)?;
        if inserted == 0 && existing.intent_hash != operation.intent_hash {
            return Err("lifecycle operation identity conflicts".to_owned());
        }
        let token = next_fencing_token(&transaction)?;
        let changed = transaction
            .execute(
                "UPDATE lifecycle_operations
                 SET claim_owner = ?2, claimed_until = ?3, claim_token = ?5
                 WHERE operation_id = ?1
                   AND (claim_owner IS NULL OR claimed_until <= ?4)",
                params![
                    operation.operation_id,
                    self.claim_owner,
                    claimed_until,
                    now,
                    token
                ],
            )
            .map_err(|_| "lifecycle operation claim failed")?;
        transaction
            .commit()
            .map_err(|_| "lifecycle operation create commit failed")?;
        Ok((changed == 1).then_some((existing, token)))
    }

    pub fn get(&self, operation_id: &str) -> Result<Option<LifecycleOperation>, String> {
        let connection = self.lock()?;
        self.get_optional_with_connection(&connection, operation_id)
    }

    pub fn input(&self, operation_id: &str) -> Result<LifecycleInput, String> {
        let connection = self.lock()?;
        let bytes: Vec<u8> = connection
            .query_row(
                "SELECT input FROM lifecycle_operations WHERE operation_id = ?1",
                [operation_id],
                |row| row.get(0),
            )
            .map_err(|_| "lifecycle operation was not found")?;
        serde_json::from_slice(&bytes).map_err(|_| "lifecycle input is corrupt".to_owned())
    }

    pub fn private_material(&self, operation_id: &str) -> Result<Option<Vec<u8>>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT private_material FROM lifecycle_operations WHERE operation_id = ?1",
                [operation_id],
                |row| row.get(0),
            )
            .map_err(|_| "lifecycle operation was not found".to_owned())
    }

    pub fn put(
        &self,
        operation: &LifecycleOperation,
        private_material: Option<&[u8]>,
        token: u64,
    ) -> Result<(), String> {
        let encoded =
            serde_json::to_vec(operation).map_err(|_| "lifecycle operation encoding failed")?;
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_operations
                 SET operation = ?2,
                     private_material = COALESCE(?3, private_material)
                 WHERE operation_id = ?1 AND intent_hash = ?4
                   AND claim_owner = ?5 AND claim_token = ?6 AND claimed_until > ?7",
                params![
                    operation.operation_id,
                    encoded,
                    private_material,
                    operation.intent_hash,
                    self.claim_owner,
                    token,
                    now
                ],
            )
            .map_err(|_| "lifecycle operation update failed")?;
        if changed != 1 {
            return Err("lifecycle operation claim was lost".to_owned());
        }
        Ok(())
    }

    pub fn try_claim(&self, operation_id: &str) -> Result<Option<u64>, String> {
        let now = self.clock.now()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle operation claim transaction failed")?;
        if reset_claim_active(&transaction, now)? {
            return Ok(None);
        }
        let token = next_fencing_token(&transaction)?;
        let changed = transaction
            .execute(
                "UPDATE lifecycle_operations
                 SET claim_owner = ?2, claimed_until = ?3, claim_token = ?5
                 WHERE operation_id = ?1
                   AND (claim_owner IS NULL OR claimed_until <= ?4)",
                params![operation_id, self.claim_owner, claimed_until, now, token],
            )
            .map_err(|_| "lifecycle operation claim failed")?;
        transaction
            .commit()
            .map_err(|_| "lifecycle operation claim commit failed")?;
        Ok((changed == 1).then_some(token))
    }

    pub fn try_claim_reset(&self) -> Result<Option<u64>, String> {
        let now = self.clock.now()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle reset claim transaction failed")?;
        if reset_claim_active(&transaction, now)? {
            return Ok(None);
        }
        let active_operations: u64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM lifecycle_operations
                 WHERE claim_owner IS NOT NULL AND claimed_until > ?1",
                [now],
                |row| row.get(0),
            )
            .map_err(|_| "lifecycle reset claim lookup failed")?;
        if active_operations != 0 {
            return Ok(None);
        }
        let token = next_fencing_token(&transaction)?;
        for (name, value) in [
            ("reset_owner", self.claim_owner.clone()),
            ("reset_until", claimed_until.to_string()),
            ("reset_token", token.to_string()),
        ] {
            transaction
                .execute(
                    "INSERT INTO lifecycle_metadata(name, value) VALUES (?1, ?2)
                     ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                    params![name, value.as_bytes()],
                )
                .map_err(|_| "lifecycle reset claim failed")?;
        }
        transaction
            .commit()
            .map_err(|_| "lifecycle reset claim commit failed")?;
        Ok(Some(token))
    }

    pub fn renew_reset(&self, token: u64) -> Result<(), String> {
        let now = self.clock.now()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        require_reset_claim(&connection, &self.claim_owner, token, now)?;
        connection
            .execute(
                "UPDATE lifecycle_metadata SET value = ?1 WHERE name = 'reset_until'",
                [claimed_until.to_string().as_bytes()],
            )
            .map_err(|_| "lifecycle reset claim renewal failed")?;
        Ok(())
    }

    pub fn release_reset(&self, token: u64) -> Result<(), String> {
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle reset release transaction failed")?;
        require_reset_claim(&transaction, &self.claim_owner, token, now)?;
        transaction
            .execute(
                "DELETE FROM lifecycle_metadata
                 WHERE name IN ('reset_owner', 'reset_until', 'reset_token')",
                [],
            )
            .map_err(|_| "lifecycle reset claim release failed")?;
        transaction
            .commit()
            .map_err(|_| "lifecycle reset release commit failed")?;
        Ok(())
    }

    pub fn renew_claim(&self, operation_id: &str, token: u64) -> Result<(), String> {
        let now = self.clock.now()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_operations SET claimed_until = ?3
                 WHERE operation_id = ?1 AND claim_owner = ?2
                   AND claim_token = ?4 AND claimed_until > ?5",
                params![operation_id, self.claim_owner, claimed_until, token, now],
            )
            .map_err(|_| "lifecycle operation claim renewal failed")?;
        if changed != 1 {
            return Err("lifecycle operation claim was lost".to_owned());
        }
        Ok(())
    }

    pub fn release(&self, operation_id: &str, token: u64) -> Result<(), String> {
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_operations
                 SET claim_owner = NULL, claimed_until = 0
                 WHERE operation_id = ?1 AND claim_owner = ?2
                   AND claim_token = ?3 AND claimed_until > ?4",
                params![operation_id, self.claim_owner, token, now],
            )
            .map_err(|_| "lifecycle operation claim release failed")?;
        if changed != 1 {
            return Err("lifecycle operation claim was lost".to_owned());
        }
        Ok(())
    }

    pub fn commit(
        &self,
        operation: &LifecycleOperation,
        private_material: Option<&[u8]>,
        effect_id: &str,
        evidence: &LifecycleEvidence,
        send_handoff: Option<&LifecycleSendHandoff>,
        token: u64,
    ) -> Result<(), String> {
        let operation_value =
            serde_json::to_vec(operation).map_err(|_| "lifecycle operation encoding failed")?;
        let evidence_value =
            serde_json::to_vec(evidence).map_err(|_| "lifecycle evidence encoding failed")?;
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle commit transaction failed")?;
        let changed = transaction
            .execute(
                "UPDATE lifecycle_operations
                 SET operation = ?2,
                     private_material = COALESCE(?3, private_material)
                 WHERE operation_id = ?1 AND intent_hash = ?4
                   AND claim_owner = ?5 AND claim_token = ?6 AND claimed_until > ?7",
                params![
                    operation.operation_id,
                    operation_value,
                    private_material,
                    operation.intent_hash,
                    self.claim_owner,
                    token,
                    now
                ],
            )
            .map_err(|_| "lifecycle operation update failed")?;
        if changed != 1 {
            return Err("lifecycle operation claim was lost".to_owned());
        }
        let previous: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT value FROM lifecycle_evidence WHERE effect_id = ?1",
                [effect_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle evidence lookup failed")?;
        match previous {
            Some(previous) if previous != evidence_value => {
                return Err("lifecycle evidence identity conflicts".to_owned());
            }
            Some(_) => {}
            None => {
                transaction
                    .execute(
                        "INSERT INTO lifecycle_evidence(effect_id, sequence, value)
                         VALUES (?1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM lifecycle_evidence), ?2)",
                        params![effect_id, evidence_value],
                    )
                    .map_err(|_| "lifecycle evidence persistence failed")?;
            }
        }
        if let Some(handoff) = send_handoff {
            let token_hash = send_token_hash(&handoff.token);
            let changed = transaction
                .execute(
                    "INSERT INTO lifecycle_send_outbox AS existing
                     (operation_id, recipient, token, token_hash)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(operation_id) DO UPDATE SET operation_id = excluded.operation_id
                     WHERE existing.recipient = excluded.recipient
                       AND existing.token_hash = excluded.token_hash",
                    params![
                        operation.operation_id,
                        handoff.recipient,
                        handoff.token.as_bytes(),
                        token_hash
                    ],
                )
                .map_err(|_| "lifecycle send handoff persistence failed")?;
            if changed != 1 {
                return Err("lifecycle send handoff identity conflicts".to_owned());
            }
        }
        transaction
            .commit()
            .map_err(|_| "lifecycle commit failed")?;
        Ok(())
    }

    pub fn evidence(&self) -> Result<Vec<LifecycleEvidence>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT sequence, value FROM lifecycle_evidence ORDER BY sequence")
            .map_err(|_| "lifecycle evidence query failed")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, u64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|_| "lifecycle evidence query failed")?;
        rows.map(|row| {
            let (sequence, bytes) = row.map_err(|_| "lifecycle evidence read failed")?;
            let mut evidence: LifecycleEvidence =
                serde_json::from_slice(&bytes).map_err(|_| "lifecycle evidence is corrupt")?;
            evidence.sequence = sequence;
            Ok(evidence)
        })
        .collect()
    }

    pub fn claim_send_handoff(
        &self,
        consumer_id: &str,
    ) -> Result<Option<ClaimedSendHandoff>, String> {
        if consumer_id.is_empty() || consumer_id.len() > 128 {
            return Err("lifecycle send handoff consumer is invalid".to_owned());
        }
        let now = self.clock.now()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle send handoff claim transaction failed")?;
        let row: Option<(String, String, Vec<u8>, String)> = transaction
            .query_row(
                "SELECT operation_id, recipient, token, token_hash
                 FROM lifecycle_send_outbox
                 WHERE acknowledged = 0
                   AND (claimed_by IS NULL OR claimed_until <= ?2 OR claimed_by = ?1)
                 ORDER BY operation_id LIMIT 1",
                params![consumer_id, now],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| "lifecycle send handoff lookup failed")?;
        let Some((operation_id, recipient, token, token_hash)) = row else {
            return Ok(None);
        };
        let claim_token = next_fencing_token(&transaction)?;
        let changed = transaction
            .execute(
                "UPDATE lifecycle_send_outbox
                 SET claimed_by = ?2, claimed_until = ?3, claim_token = ?5
                 WHERE operation_id = ?1 AND acknowledged = 0
                   AND (claimed_by IS NULL OR claimed_until <= ?4 OR claimed_by = ?2)",
                params![operation_id, consumer_id, claimed_until, now, claim_token],
            )
            .map_err(|_| "lifecycle send handoff claim failed")?;
        if changed != 1 {
            return Err("lifecycle send handoff claim conflicts".to_owned());
        }
        transaction
            .commit()
            .map_err(|_| "lifecycle send handoff claim commit failed")?;
        let token =
            String::from_utf8(token).map_err(|_| "lifecycle send handoff is corrupt".to_owned())?;
        if send_token_hash(&token) != token_hash {
            return Err("lifecycle send handoff hash conflicts".to_owned());
        }
        Ok(Some(ClaimedSendHandoff {
            operation_id,
            recipient,
            token,
            token_hash,
            claim_token,
        }))
    }

    pub fn acknowledge_send_handoff(
        &self,
        operation_id: &str,
        token_hash: &str,
        consumer_id: &str,
        claim_token: u64,
    ) -> Result<(), String> {
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_send_outbox SET acknowledged = 1
                 WHERE operation_id = ?1 AND token_hash = ?2 AND claimed_by = ?3
                   AND claim_token = ?4 AND claimed_until > ?5 AND acknowledged = 0",
                params![operation_id, token_hash, consumer_id, claim_token, now],
            )
            .map_err(|_| "lifecycle send handoff acknowledgement failed")?;
        if changed != 1 {
            return Err("lifecycle send handoff claim was lost".to_owned());
        }
        Ok(())
    }

    pub fn release_send_handoff(
        &self,
        operation_id: &str,
        consumer_id: &str,
        claim_token: u64,
    ) -> Result<(), String> {
        let now = self.clock.now()?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_send_outbox
                 SET claimed_by = NULL, claimed_until = 0
                 WHERE operation_id = ?1 AND claimed_by = ?2 AND claim_token = ?3
                   AND claimed_until > ?4 AND acknowledged = 0",
                params![operation_id, consumer_id, claim_token, now],
            )
            .map_err(|_| "lifecycle send handoff release failed")?;
        if changed != 1 {
            return Err("lifecycle send handoff claim was lost".to_owned());
        }
        Ok(())
    }

    fn get_with_connection(
        &self,
        connection: &Connection,
        operation_id: &str,
    ) -> Result<LifecycleOperation, String> {
        self.get_optional_with_connection(connection, operation_id)?
            .ok_or_else(|| "lifecycle operation was not found".to_owned())
    }

    fn get_optional_with_connection(
        &self,
        connection: &Connection,
        operation_id: &str,
    ) -> Result<Option<LifecycleOperation>, String> {
        let bytes: Option<Vec<u8>> = connection
            .query_row(
                "SELECT operation FROM lifecycle_operations WHERE operation_id = ?1",
                [operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle operation lookup failed")?;
        bytes
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|_| "lifecycle operation is corrupt".to_owned())
            })
            .transpose()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "lifecycle database lock failed".to_owned())
    }
}

fn reset_claim_active(connection: &Connection, now: u64) -> Result<bool, String> {
    let value: Option<Vec<u8>> = connection
        .query_row(
            "SELECT value FROM lifecycle_metadata WHERE name = 'reset_until'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "lifecycle reset claim lookup failed")?;
    Ok(value
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|claimed_until| claimed_until > now))
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| "lifecycle database migration failed")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "lifecycle database migration failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "lifecycle database migration failed")?;
    Ok(columns.iter().any(|candidate| candidate == column))
}

fn next_fencing_token(connection: &Connection) -> Result<u64, String> {
    let current: Option<Vec<u8>> = connection
        .query_row(
            "SELECT value FROM lifecycle_metadata WHERE name = 'next_fencing_token'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "lifecycle fencing token lookup failed")?;
    let current = current
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let next = current
        .checked_add(1)
        .ok_or_else(|| "lifecycle fencing token exhausted".to_owned())?;
    connection
        .execute(
            "INSERT INTO lifecycle_metadata(name, value) VALUES ('next_fencing_token', ?1)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            [next.to_string().as_bytes()],
        )
        .map_err(|_| "lifecycle fencing token persistence failed")?;
    Ok(next)
}

fn metadata_u64(connection: &Connection, name: &str) -> Result<Option<u64>, String> {
    let value: Option<Vec<u8>> = connection
        .query_row(
            "SELECT value FROM lifecycle_metadata WHERE name = ?1",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "lifecycle metadata lookup failed")?;
    value
        .map(|bytes| {
            std::str::from_utf8(&bytes)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| "lifecycle metadata is corrupt".to_owned())
        })
        .transpose()
}

fn require_reset_claim(
    connection: &Connection,
    owner: &str,
    token: u64,
    now: u64,
) -> Result<(), String> {
    let read = |name: &str| -> Result<Option<Vec<u8>>, String> {
        connection
            .query_row(
                "SELECT value FROM lifecycle_metadata WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle reset claim lookup failed".to_owned())
    };
    let stored_owner = read("reset_owner")?;
    let stored_token = read("reset_token")?
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|value| value.parse::<u64>().ok());
    let stored_until = read("reset_until")?
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|value| value.parse::<u64>().ok());
    if stored_owner.as_deref() != Some(owner.as_bytes())
        || stored_token != Some(token)
        || stored_until.is_none_or(|until| until <= now)
    {
        return Err("lifecycle reset claim was lost".to_owned());
    }
    Ok(())
}

fn lifecycle_seed_hash(seed: &str) -> String {
    let mut material = b"cashu-fault-lab/cdk-lifecycle-seed-hash-v1\0".to_vec();
    material.extend_from_slice(seed.as_bytes());
    sha256::Hash::hash(&material).to_string()
}

fn send_token_hash(token: &str) -> String {
    let mut material = b"cashu-fault-lab/cdk-lifecycle-send-token/v1\0".to_vec();
    material.extend_from_slice(token.as_bytes());
    sha256::Hash::hash(&material).to_string()
}
