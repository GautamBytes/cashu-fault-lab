//! Bounded native CDK/Nostr receiver for disposable loopback interoperability tests.
mod journal;
mod mint;
mod protocol;
mod relay;
#[cfg(test)]
mod tests;

use cdk::nuts::Proof;
use journal::Journal;
use mint::Mint;
use nostr::prelude::{Event, Keys};
use protocol::Zap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub database: PathBuf,
    pub key_hex: String,
    pub lock_hex: String,
    pub info: Event,
    pub event: Event,
    pub relays: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Output {
    id: String,
    amount: u64,
    secret: String,
}
#[derive(Clone, Deserialize, Serialize)]
struct Plan {
    material: String,
    outputs: Vec<Output>,
    fee: u64,
}
#[derive(Clone, Deserialize, Serialize)]
struct Record {
    zap: Zap,
    plan: Plan,
    credit: Option<u64>,
    events: Vec<Event>,
    published: Vec<String>,
    origin: Option<String>,
}

fn validate_outputs(record: &Record, proofs: &[Proof]) -> Result<()> {
    if protocol::amount(proofs)?.checked_add(record.plan.fee) != Some(record.zap.amount)
        || proofs.len() != record.plan.outputs.len()
        || proofs.iter().any(|p| {
            !record.plan.outputs.iter().any(|o| {
                o.id == p.keyset_id.to_string()
                    && o.amount == p.amount.to_u64()
                    && o.secret == p.secret.to_string()
            })
        })
    {
        return Err("output_identity_mismatch");
    }
    Ok(())
}

/// Checkpoints expose ordering only; the harness never performs CDK mint or relay operations.
pub async fn receive(
    config: Config,
    mut checkpoint: impl FnMut(&str) -> Result<()>,
) -> Result<&'static str> {
    let zap = protocol::validate(&config)?;
    let keys = Keys::parse(&config.key_hex).map_err(|_| "invalid_wallet_key")?;
    let mut db = Journal::open(&config.database)?;
    let mint = Mint::new(&zap.mint, &config.lock_hex).await?;
    mint.verify(&zap.proofs)?;
    let saved = db.get(&zap.id)?;
    let plan = match saved {
        Some(ref r) => r.plan.clone(),
        None => mint.prepare(&zap)?,
    };
    let mut record = db.reserve(&Record {
        zap,
        plan,
        credit: None,
        events: vec![],
        published: vec![],
        origin: None,
    })?;
    if record.credit.is_none() {
        let mut proofs = mint.restore(&record.plan).await?;
        if proofs.is_empty() {
            let states = mint.states(&record.zap.proofs).await?;
            if states.iter().any(|s| s == "PENDING") {
                return Ok("pending");
            }
            if states.iter().all(|s| s == "UNSPENT") {
                checkpoint("before-swap")?;
                match mint.swap(&record.zap, &record.plan).await {
                    Ok(outputs) => {
                        proofs = outputs;
                        checkpoint("after-swap")?;
                    }
                    Err(_) => {
                        proofs = mint.restore(&record.plan).await?;
                    }
                }
            }
        }
        if proofs.is_empty() {
            let mut events = Vec::new();
            for relay in &config.relays {
                if let Ok(found) = relay::query(relay, &record.zap.recipient).await {
                    events.extend(found);
                }
            }
            let Some((events, proofs)) =
                protocol::peer_candidate(&record.zap, record.plan.fee, &keys, events)
                    .unwrap_or(None)
            else {
                return Ok("awaiting-peer");
            };
            if mint.verify(&proofs).is_err()
                || !mint
                    .states(&record.zap.proofs)
                    .await?
                    .iter()
                    .all(|s| s == "SPENT")
                || !mint.states(&proofs).await?.iter().all(|s| s == "UNSPENT")
            {
                return Ok("awaiting-peer");
            }
            record = db.credit(&record, &proofs, events, "relay")?;
        } else {
            validate_outputs(&record, &proofs)?;
            if !mint.states(&proofs).await?.iter().all(|s| s == "UNSPENT") {
                return Ok("recovery-blocked");
            }
            let events = protocol::wallet_events(&record.zap, &proofs, &keys)?;
            record = db.credit(&record, &proofs, events, "local")?;
        }
    }
    checkpoint("before-publish")?;
    for relay in &config.relays {
        for event in &record.events {
            let target =
                serde_json::to_string(&(relay, event.id.to_hex())).map_err(|_| "invalid_target")?;
            if db.acknowledged(&record.zap.id, &target)? {
                continue;
            }
            if relay::publish(relay, event).await.is_err() {
                return Ok("publication-pending");
            }
            db.acknowledge(&record.zap.id, &target)?;
        }
    }
    Ok("complete")
}
