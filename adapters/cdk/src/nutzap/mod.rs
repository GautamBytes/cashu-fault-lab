//! Bounded native CDK/Nostr receiver for disposable loopback interoperability tests.
mod journal;
mod mint;
mod protocol;
mod receiving_keys;
mod relay;
mod spend;
#[cfg(test)]
mod tests;
mod wallet;

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
    #[serde(default)]
    pub receiving_keys: Option<PathBuf>,
    pub info: Event,
    pub event: Event,
    pub relays: Vec<String>,
    #[serde(default)]
    pub spend_amount: Option<u64>,
    #[serde(default)]
    pub sync_wallet: bool,
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
    #[serde(default)]
    wallet: Option<Wallet>,
    #[serde(default)]
    spend: Option<Spend>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Wallet {
    token: Option<Event>,
    proofs: Vec<Proof>,
    retired: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpendPlan {
    #[serde(flatten)]
    plan: Plan,
    send_secrets: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Spend {
    amount: u64,
    plan: SpendPlan,
    events: Vec<Event>,
    sent: Vec<Proof>,
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
    mut config: Config,
    mut checkpoint: impl FnMut(&str) -> Result<()>,
) -> Result<&'static str> {
    if config.receiving_keys.is_some() {
        let Some((info, secret)) = receiving_keys::select(&config)? else {
            checkpoint("missing-receiving-key")?;
            return Ok("recovery-blocked");
        };
        config.info = info;
        config.lock_hex = secret;
        checkpoint("receiving-key-selected")?;
    }
    let zap = protocol::validate(&config)?;
    let keys = Keys::parse(&config.key_hex).map_err(|_| "invalid_wallet_key")?;
    let mut db = Journal::open(&config.database)?;
    let mint = Mint::new(&zap.mint, &config.lock_hex).await?;
    mint.verify(&zap.proofs)?;
    if config.spend_amount.is_some() && config.sync_wallet {
        return Err("conflicting_operation");
    }
    if let Some(amount) = config.spend_amount {
        return spend::run(
            &config,
            &zap.id,
            amount,
            &keys,
            &mint,
            &mut db,
            &mut checkpoint,
        )
        .await;
    }
    if config.sync_wallet {
        let result = wallet::sync(&config, &zap.id, &keys, &mint, &mut db).await?;
        checkpoint("after-wallet-sync")?;
        return Ok(result);
    }
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
        wallet: None,
        spend: None,
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
