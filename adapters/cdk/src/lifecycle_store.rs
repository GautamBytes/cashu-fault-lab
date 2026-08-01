use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use bitcoin::hashes::{Hash, sha256};
use rusqlite::{Connection, OptionalExtension, params};

use crate::lifecycle::{LifecycleEvidence, LifecycleInput, LifecycleOperation};

/// SQLCipher-backed lifecycle journal. Secret request material, quote IDs, and tokens are only
/// present inside the encrypted database and are never projected into evidence. Raw seeds are not
/// persisted at all.
pub struct LifecycleStore {
    connection: Mutex<Connection>,
    claim_owner: String,
}

const CLAIM_LEASE_SECONDS: u64 = 120;

impl LifecycleStore {
    pub fn open(path: impl AsRef<Path>, key: [u8; 32]) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|_| "lifecycle database open failed")?;
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
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
        connection
            .execute("DELETE FROM lifecycle_metadata WHERE name = 'seed'", [])
            .map_err(|_| "legacy lifecycle seed removal failed")?;
        let mut owner = [0_u8; 16];
        getrandom::fill(&mut owner).map_err(|_| "lifecycle claim owner generation failed")?;
        Ok(Self {
            connection: Mutex::new(connection),
            claim_owner: hex::encode(owner),
        })
    }

    pub fn reset(&self, seed: &str) -> Result<(), String> {
        if seed.is_empty() || seed.len() > 256 {
            return Err("lifecycle seed is invalid".to_owned());
        }
        let seed_hash = lifecycle_seed_hash(seed);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle reset transaction failed")?;
        transaction
            .execute("DELETE FROM lifecycle_evidence", [])
            .and_then(|_| transaction.execute("DELETE FROM lifecycle_operations", []))
            .and_then(|_| {
                transaction.execute(
                    "INSERT INTO lifecycle_metadata(name, value) VALUES ('seed_hash', ?1)
                     ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                    [seed_hash.as_bytes()],
                )
            })
            .map_err(|_| "lifecycle reset failed")?;
        transaction
            .commit()
            .map_err(|_| "lifecycle reset commit failed")?;
        Ok(())
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

    pub fn create(
        &self,
        input: &LifecycleInput,
        operation: &LifecycleOperation,
    ) -> Result<LifecycleOperation, String> {
        let input_json =
            serde_json::to_vec(input).map_err(|_| "lifecycle input encoding failed")?;
        let operation_json =
            serde_json::to_vec(operation).map_err(|_| "lifecycle operation encoding failed")?;
        let connection = self.lock()?;
        let inserted = connection
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
        let existing = self.get_with_connection(&connection, &operation.operation_id)?;
        if inserted == 0 && existing.intent_hash != operation.intent_hash {
            return Err("lifecycle operation identity conflicts".to_owned());
        }
        Ok(existing)
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
    ) -> Result<(), String> {
        let encoded =
            serde_json::to_vec(operation).map_err(|_| "lifecycle operation encoding failed")?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_operations
                 SET operation = ?2,
                     private_material = COALESCE(?3, private_material)
                 WHERE operation_id = ?1 AND intent_hash = ?4",
                params![
                    operation.operation_id,
                    encoded,
                    private_material,
                    operation.intent_hash
                ],
            )
            .map_err(|_| "lifecycle operation update failed")?;
        if changed != 1 {
            return Err("lifecycle operation identity conflicts".to_owned());
        }
        Ok(())
    }

    pub fn try_claim(&self, operation_id: &str) -> Result<bool, String> {
        let now = unix_time()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle operation claim transaction failed")?;
        if reset_claim_active(&transaction, now)? {
            return Ok(false);
        }
        let changed = transaction
            .execute(
                "UPDATE lifecycle_operations SET claim_owner = ?2, claimed_until = ?3
                 WHERE operation_id = ?1
                   AND (claim_owner IS NULL OR claimed_until <= ?4)",
                params![operation_id, self.claim_owner, claimed_until, now],
            )
            .map_err(|_| "lifecycle operation claim failed")?;
        transaction
            .commit()
            .map_err(|_| "lifecycle operation claim commit failed")?;
        Ok(changed == 1)
    }

    pub fn try_claim_reset(&self) -> Result<bool, String> {
        let now = unix_time()?;
        let claimed_until = now.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle reset claim transaction failed")?;
        if reset_claim_active(&transaction, now)? {
            return Ok(false);
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
            return Ok(false);
        }
        for (name, value) in [
            ("reset_owner", self.claim_owner.clone()),
            ("reset_until", claimed_until.to_string()),
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
        Ok(true)
    }

    pub fn renew_reset(&self) -> Result<(), String> {
        let claimed_until = unix_time()?.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let owner: Option<Vec<u8>> = connection
            .query_row(
                "SELECT value FROM lifecycle_metadata WHERE name = 'reset_owner'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle reset claim lookup failed")?;
        if owner.as_deref() != Some(self.claim_owner.as_bytes()) {
            return Err("lifecycle reset claim was lost".to_owned());
        }
        connection
            .execute(
                "UPDATE lifecycle_metadata SET value = ?1 WHERE name = 'reset_until'",
                [claimed_until.to_string().as_bytes()],
            )
            .map_err(|_| "lifecycle reset claim renewal failed")?;
        Ok(())
    }

    pub fn release_reset(&self) -> Result<(), String> {
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle reset release transaction failed")?;
        let owner: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT value FROM lifecycle_metadata WHERE name = 'reset_owner'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle reset claim lookup failed")?;
        if owner.as_deref() == Some(self.claim_owner.as_bytes()) {
            transaction
                .execute(
                    "DELETE FROM lifecycle_metadata WHERE name IN ('reset_owner', 'reset_until')",
                    [],
                )
                .map_err(|_| "lifecycle reset claim release failed")?;
        }
        transaction
            .commit()
            .map_err(|_| "lifecycle reset release commit failed")?;
        Ok(())
    }

    pub fn renew_claim(&self, operation_id: &str) -> Result<(), String> {
        let claimed_until = unix_time()?.saturating_add(CLAIM_LEASE_SECONDS);
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE lifecycle_operations SET claimed_until = ?3
                 WHERE operation_id = ?1 AND claim_owner = ?2",
                params![operation_id, self.claim_owner, claimed_until],
            )
            .map_err(|_| "lifecycle operation claim renewal failed")?;
        if changed != 1 {
            return Err("lifecycle operation claim was lost".to_owned());
        }
        Ok(())
    }

    pub fn release(&self, operation_id: &str) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE lifecycle_operations SET claim_owner = NULL, claimed_until = 0
                 WHERE operation_id = ?1 AND claim_owner = ?2",
                params![operation_id, self.claim_owner],
            )
            .map_err(|_| "lifecycle operation claim release failed")?;
        Ok(())
    }

    pub fn append_evidence(
        &self,
        effect_id: &str,
        evidence: &LifecycleEvidence,
    ) -> Result<(), String> {
        let value =
            serde_json::to_vec(evidence).map_err(|_| "lifecycle evidence encoding failed")?;
        let connection = self.lock()?;
        let previous: Option<Vec<u8>> = connection
            .query_row(
                "SELECT value FROM lifecycle_evidence WHERE effect_id = ?1",
                [effect_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "lifecycle evidence lookup failed")?;
        if let Some(previous) = previous {
            return if previous == value {
                Ok(())
            } else {
                Err("lifecycle evidence identity conflicts".to_owned())
            };
        }
        connection
            .execute(
                "INSERT INTO lifecycle_evidence(effect_id, sequence, value)
                 VALUES (?1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM lifecycle_evidence), ?2)",
                params![effect_id, value],
            )
            .map_err(|_| "lifecycle evidence persistence failed")?;
        Ok(())
    }

    pub fn commit(
        &self,
        operation: &LifecycleOperation,
        private_material: Option<&[u8]>,
        effect_id: &str,
        evidence: &LifecycleEvidence,
    ) -> Result<(), String> {
        let operation_value =
            serde_json::to_vec(operation).map_err(|_| "lifecycle operation encoding failed")?;
        let evidence_value =
            serde_json::to_vec(evidence).map_err(|_| "lifecycle evidence encoding failed")?;
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| "lifecycle commit transaction failed")?;
        let changed = transaction
            .execute(
                "UPDATE lifecycle_operations
                 SET operation = ?2,
                     private_material = COALESCE(?3, private_material)
                 WHERE operation_id = ?1 AND intent_hash = ?4",
                params![
                    operation.operation_id,
                    operation_value,
                    private_material,
                    operation.intent_hash
                ],
            )
            .map_err(|_| "lifecycle operation update failed")?;
        if changed != 1 {
            return Err("lifecycle operation identity conflicts".to_owned());
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

fn unix_time() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is invalid".to_owned())
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

fn lifecycle_seed_hash(seed: &str) -> String {
    let mut material = b"cashu-fault-lab/cdk-lifecycle-seed-hash-v1\0".to_vec();
    material.extend_from_slice(seed.as_bytes());
    sha256::Hash::hash(&material).to_string()
}
