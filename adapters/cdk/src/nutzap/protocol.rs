use std::collections::BTreeSet;

use bitcoin::hashes::{Hash, sha256};
use cdk::nuts::Proof;
use nostr::prelude::{Event, EventBuilder, FinalizeEvent, Keys, Kind, Tag, Timestamp, nip44};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Config, Result};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Zap {
    pub id: String,
    pub event: Event,
    pub mint: String,
    pub recipient: String,
    pub locking_key: String,
    pub proofs: Vec<Proof>,
    pub amount: u64,
}

pub fn tags(event: &Event, name: &str) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .map(|t| t.as_slice().to_vec())
        .filter(|t| t.first().is_some_and(|v| v == name))
        .collect()
}

fn single(event: &Event, name: &str) -> Result<String> {
    let found = tags(event, name);
    match found.as_slice() {
        [tag] if tag.len() == 2 => Ok(tag[1].clone()),
        _ => Err("ambiguous_nutzap_tag"),
    }
}

pub fn local_url(value: &str, scheme: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| "invalid_local_url")?;
    if url.scheme() != scheme
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("nonlocal_endpoint");
    }
    Ok(())
}

pub fn amount(proofs: &[Proof]) -> Result<u64> {
    if proofs.is_empty() || proofs.len() > 64 {
        return Err("invalid_proof_count");
    }
    let mut sum = 0_u64;
    let mut ys = BTreeSet::new();
    for p in proofs {
        let value = p.amount.to_u64();
        if value == 0
            || p.secret.to_string().len() > 8192
            || !ys.insert(p.y().map_err(|_| "invalid_proof")?.to_string())
        {
            return Err("invalid_proof");
        }
        sum = sum.checked_add(value).ok_or("invalid_amount")?;
    }
    if sum > 1_000_000 {
        return Err("invalid_amount");
    }
    Ok(sum)
}

pub fn validate(config: &Config) -> Result<Zap> {
    let event = &config.event;
    let info = &config.info;
    event.verify().map_err(|_| "invalid_event_signature")?;
    info.verify().map_err(|_| "invalid_info_signature")?;
    if event.kind.as_u16() != 9321 || info.kind.as_u16() != 10019 {
        return Err("invalid_nutzap_kind");
    }
    if event.created_at.as_secs() > 9_007_199_254_740_990 {
        return Err("unsupported_timestamp");
    }
    let recipient = single(event, "p")?;
    let locking_key = single(info, "pubkey")?;
    let mint = single(event, "u")?;
    let keys = Keys::parse(&config.key_hex).map_err(|_| "invalid_wallet_key")?;
    let lock = Keys::parse(&config.lock_hex).map_err(|_| "invalid_lock_key")?;
    if recipient != info.pubkey.to_hex()
        || recipient != keys.public_key().to_hex()
        || locking_key != lock.public_key().to_hex()
        || locking_key == recipient
    {
        return Err("wrong_recipient_or_lock");
    }
    if !tags(event, "unit").is_empty() && single(event, "unit")? != "sat" {
        return Err("unsupported_unit");
    }
    if !tags(info, "mint")
        .iter()
        .any(|t| t.get(1) == Some(&mint) && (t.len() == 2 || t[2..].iter().any(|u| u == "sat")))
    {
        return Err("unadvertised_mint");
    }
    local_url(&mint, "http")?;
    if config.relays.is_empty() || config.relays.len() > 4 {
        return Err("invalid_relays");
    }
    for relay in &config.relays {
        local_url(relay, "ws")?;
    }
    let proof_tags = tags(event, "proof");
    if proof_tags.is_empty() || proof_tags.len() > 64 {
        return Err("invalid_proof_count");
    }
    let mut proofs = Vec::new();
    for tag in proof_tags {
        if tag.len() != 2 || tag[1].len() > 8192 {
            return Err("invalid_proof_tag");
        }
        let proof: Proof = serde_json::from_str(&tag[1]).map_err(|_| "invalid_proof")?;
        if proof.dleq.is_none() {
            return Err("missing_dleq");
        }
        let secret: Value =
            serde_json::from_str(&proof.secret.to_string()).map_err(|_| "invalid_lock")?;
        let body = secret
            .get(1)
            .and_then(Value::as_object)
            .ok_or("invalid_lock")?;
        if secret.as_array().map(Vec::len) != Some(2)
            || secret[0] != "P2PK"
            || body.get("data") != Some(&json!(format!("02{locking_key}")))
            || !body.get("nonce").is_some_and(Value::is_string)
            || body
                .keys()
                .any(|k| !["nonce", "data", "tags"].contains(&k.as_str()))
            || body
                .get("tags")
                .is_some_and(|t| *t != json!([]) && *t != json!([["sigflag", "SIG_INPUTS"]]))
        {
            return Err("unsupported_lock");
        }
        proofs.push(proof);
    }
    let amount = amount(&proofs)?;
    let ys: BTreeSet<_> = proofs
        .iter()
        .map(|p| p.y().map(|y| y.to_string()))
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| "invalid_proof")?;
    let id = sha256::Hash::hash(
        format!(
            "cashu-fault-lab/nip61-economic-v1\0{mint}\0{}",
            ys.into_iter().collect::<Vec<_>>().join("\0")
        )
        .as_bytes(),
    )
    .to_string();
    Ok(Zap {
        id,
        event: event.clone(),
        mint,
        recipient,
        locking_key,
        proofs,
        amount,
    })
}

pub fn wallet_events(zap: &Zap, proofs: &[Proof], keys: &Keys) -> Result<Vec<Event>> {
    let encrypt = |v: Value| {
        nip44::encrypt(
            keys.secret_key(),
            &keys.public_key(),
            v.to_string(),
            nip44::Version::V2,
        )
        .map_err(|_| "encryption_failed")
    };
    let token = EventBuilder::new(
        Kind::from(7375),
        encrypt(json!({"mint": zap.mint, "unit": "sat", "proofs": proofs, "del": []}))?,
    )
    .custom_created_at(Timestamp::from_secs(zap.event.created_at.as_secs() + 1))
    .finalize(keys)
    .map_err(|_| "signing_failed")?;
    let history = EventBuilder::new(
        Kind::from(7376),
        encrypt(json!([
            ["direction", "in"],
            ["amount", amount(proofs)?.to_string()],
            ["unit", "sat"],
            ["e", token.id.to_hex(), "", "created"]
        ]))?,
    )
    .tags([
        Tag::parse(["e", &zap.event.id.to_hex(), "", "redeemed"]).map_err(|_| "invalid_history")?,
        Tag::parse(["p", &zap.event.pubkey.to_hex()]).map_err(|_| "invalid_history")?,
    ])
    .custom_created_at(Timestamp::from_secs(zap.event.created_at.as_secs() + 1))
    .finalize(keys)
    .map_err(|_| "signing_failed")?;
    Ok(vec![token, history])
}

/// Signed history is only a candidate. The caller must also verify DLEQ and mint states.
pub fn peer_candidate(
    zap: &Zap,
    fee: u64,
    keys: &Keys,
    events: Vec<Event>,
) -> Result<Option<(Vec<Event>, Vec<Proof>)>> {
    let events: std::collections::BTreeMap<_, _> = events
        .into_iter()
        .filter(|e| e.pubkey == keys.public_key() && e.verify().is_ok())
        .map(|e| (e.id, e))
        .collect();
    let histories: Vec<_> = events
        .values()
        .filter(|e| {
            e.kind.as_u16() == 7376
                && tags(e, "e").iter().any(|t| {
                    t.get(1) == Some(&zap.event.id.to_hex())
                        && t.get(3).is_some_and(|v| v == "redeemed")
                })
        })
        .collect();
    let [history] = histories.as_slice() else {
        return Ok(None);
    };
    if tags(history, "e").len() != 1
        || tags(history, "p") != vec![vec!["p".to_owned(), zap.event.pubkey.to_hex()]]
    {
        return Ok(None);
    }
    let decrypt = |e: &Event| -> Result<Value> {
        let plain = nip44::decrypt(keys.secret_key(), &keys.public_key(), &e.content)
            .map_err(|_| "invalid_encryption")?;
        serde_json::from_str(&plain).map_err(|_| "invalid_wallet_payload")
    };
    let payload = decrypt(history)?;
    let history_tags: Vec<Vec<String>> =
        serde_json::from_value(payload).map_err(|_| "invalid_history")?;
    let expected = zap.amount.checked_sub(fee).ok_or("invalid_fee")?;
    for (name, value) in [
        ("direction", "in".to_owned()),
        ("unit", "sat".to_owned()),
        ("amount", expected.to_string()),
    ] {
        let found: Vec<_> = history_tags
            .iter()
            .filter(|t| t.first().is_some_and(|s| s == name))
            .collect();
        if found != vec![&vec![name.to_owned(), value]] {
            return Ok(None);
        }
    }
    let refs: Vec<_> = history_tags
        .iter()
        .filter(|t| t.first().is_some_and(|s| s == "e"))
        .collect();
    let [reference] = refs.as_slice() else {
        return Ok(None);
    };
    if reference.len() != 4 || reference[3] != "created" {
        return Ok(None);
    }
    let Some(token) = events
        .values()
        .find(|e| e.kind.as_u16() == 7375 && e.id.to_hex() == reference[1])
    else {
        return Ok(None);
    };
    let body = decrypt(token)?;
    if body["mint"] != zap.mint || body["unit"] != "sat" || body["del"] != json!([]) {
        return Ok(None);
    }
    let proofs: Vec<Proof> =
        serde_json::from_value(body["proofs"].clone()).map_err(|_| "invalid_peer_proofs")?;
    if amount(&proofs)? != expected {
        return Ok(None);
    }
    let inputs: BTreeSet<_> = zap.proofs.iter().map(|p| p.secret.to_string()).collect();
    if proofs
        .iter()
        .any(|p| inputs.contains(&p.secret.to_string()))
    {
        return Ok(None);
    }
    Ok(Some(vec![token.clone(), (*history).clone()]).map(|events| (events, proofs)))
}
