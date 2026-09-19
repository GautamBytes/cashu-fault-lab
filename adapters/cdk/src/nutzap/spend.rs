//! Durable one-shot partial spend, independently implemented using CDK blinding and restoration.
use super::{Config, Result, journal::Journal, mint::Mint, protocol, relay, wallet};
use cdk::nuts::Proof;
use nostr::prelude::Keys;

pub async fn run(
    config: &Config,
    id: &str,
    amount: u64,
    keys: &Keys,
    mint: &Mint,
    db: &mut Journal,
    checkpoint: &mut impl FnMut(&str) -> Result<()>,
) -> Result<&'static str> {
    let mut record = db.get(id)?.ok_or("missing_receipt")?;
    if amount == 0
        || amount >= record.credit.ok_or("missing_credit")?
        || record.zap.recipient != keys.public_key().to_hex()
    {
        return Err("invalid_partial_spend");
    }
    let original = record
        .events
        .iter()
        .find(|e| e.kind.as_u16() == 7375)
        .ok_or("missing_token")?;
    let inputs: Vec<Proof> =
        serde_json::from_value(wallet::decrypt(original, keys)?["proofs"].clone())
            .map_err(|_| "invalid_proofs")?;
    let mut spending = record.zap.clone();
    spending.amount = protocol::amount(&inputs)?;
    spending.proofs = inputs;
    if record.spend.is_none() {
        let plan = mint.prepare_spend(&spending, amount)?;
        record = db.prepare_spend(id, amount, plan)?;
    }
    let spend = record.spend.as_ref().ok_or("missing_spend")?;
    if spend.amount != amount {
        return Err("conflicting_spend");
    }
    checkpoint("spend-prepared")?;
    if spend.events.is_empty() {
        let plan = &spend.plan.plan;
        let mut outputs = mint.restore(plan).await?;
        if outputs.is_empty() {
            if !mint
                .states(&spending.proofs)
                .await?
                .iter()
                .all(|s| s == "UNSPENT")
            {
                return Ok("recovery-blocked");
            }
            outputs = match mint.swap(&spending, plan).await {
                Ok(proofs) => proofs,
                Err(_) => mint.restore(plan).await?,
            };
        }
        if outputs.len() != plan.outputs.len()
            || protocol::amount(&outputs)?.checked_add(plan.fee) != Some(spending.amount)
            || outputs.iter().any(|p| {
                !plan.outputs.iter().any(|o| {
                    o.secret == p.secret.to_string()
                        && o.id == p.keyset_id.to_string()
                        && o.amount == p.amount.to_u64()
                })
            })
        {
            return Ok("recovery-blocked");
        }
        mint.verify(&outputs)?;
        if !mint.states(&outputs).await?.iter().all(|s| s == "UNSPENT") {
            return Ok("recovery-blocked");
        }
        let (sent, keep): (Vec<_>, Vec<_>) = outputs
            .into_iter()
            .partition(|p| spend.plan.send_secrets.contains(&p.secret.to_string()));
        if protocol::amount(&sent)? != amount
            || protocol::amount(&keep)? + amount + plan.fee != spending.amount
        {
            return Err("spend_value_mismatch");
        }
        let events = wallet::spend_events(&record, &keep, keys)?;
        record = db.finish_spend(id, events, keep, sent)?;
    }
    for relay in &config.relays {
        for event in &record.spend.as_ref().ok_or("missing_spend")?.events {
            let target =
                serde_json::to_string(&(relay, event.id.to_hex())).map_err(|_| "invalid_target")?;
            if db.acknowledged(id, &target)? {
                continue;
            }
            if relay::publish(relay, event).await.is_err() {
                return Ok("publication-pending");
            }
            db.acknowledge(id, &target)?;
            checkpoint("after-publication")?;
        }
    }
    Ok("complete")
}
