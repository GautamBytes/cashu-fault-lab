//! One replacement token from a previously synchronized receipt; history is not balance authority.
use super::{Config, Record, Result, journal::Journal, mint::Mint, protocol, relay};
use cdk::nuts::Proof;
use nostr::prelude::{Event, Keys, nip44};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn decrypt(event: &Event, keys: &Keys) -> Result<Value> {
    let plain = nip44::decrypt(keys.secret_key(), &keys.public_key(), &event.content)
        .map_err(|_| "invalid_encryption")?;
    serde_json::from_str(&plain).map_err(|_| "invalid_wallet_payload")
}

// Only signature/shape checks here. Every returned candidate still needs DLEQ and mint states.
fn candidates(
    record: &Record,
    keys: &Keys,
    events: Vec<Event>,
    retired: &mut BTreeSet<String>,
) -> Result<Vec<(Event, Vec<Proof>, Vec<String>)>> {
    let original = record
        .events
        .iter()
        .find(|e| e.kind.as_u16() == 7375)
        .ok_or("missing_token")?;
    let events: BTreeMap<_, _> = events
        .into_iter()
        .filter(|e| {
            e.pubkey == keys.public_key()
                && e.verify().is_ok()
                && [7375, 5].contains(&e.kind.as_u16())
        })
        .map(|e| (e.id, e))
        .collect();
    for e in events.values().filter(|e| e.kind.as_u16() == 5) {
        if protocol::tags(e, "k")
            .iter()
            .any(|t| t == &vec!["k".to_owned(), "7375".to_owned()])
        {
            for tag in protocol::tags(e, "e") {
                if let Some(id) = tag.get(1).filter(|id| {
                    id.len() == 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }) {
                    retired.insert(id.clone());
                }
            }
        }
    }
    let mut found = Vec::new();
    for e in events
        .into_values()
        .filter(|e| e.kind.as_u16() == 7375 && !retired.contains(&e.id.to_hex()))
    {
        let parsed = (|| -> Result<_> {
            let body = decrypt(&e, keys)?;
            if body["mint"] != record.zap.mint || body["unit"] != "sat" {
                return Err("wrong_wallet");
            }
            let del: Vec<String> =
                serde_json::from_value(body["del"].clone()).map_err(|_| "invalid_ancestry")?;
            let expected = if e.id == original.id {
                vec![]
            } else {
                vec![original.id.to_hex()]
            };
            if del != expected {
                return Err("invalid_ancestry");
            }
            let proofs: Vec<Proof> =
                serde_json::from_value(body["proofs"].clone()).map_err(|_| "invalid_proofs")?;
            if protocol::amount(&proofs)? > record.credit.ok_or("missing_credit")? {
                return Err("invalid_amount");
            }
            Ok((proofs, del))
        })();
        if let Ok((proofs, del)) = parsed {
            found.push((e, proofs, del));
        }
    }
    Ok(found)
}

pub async fn sync(
    config: &Config,
    id: &str,
    keys: &Keys,
    mint: &Mint,
    db: &mut Journal,
) -> Result<&'static str> {
    let record = db.get(id)?.ok_or("missing_receipt")?;
    if record.credit.is_none() || record.zap.recipient != keys.public_key().to_hex() {
        return Err("missing_wallet");
    }
    if record.spend.as_ref().is_some_and(|s| s.events.is_empty()) {
        return Ok("awaiting-peer");
    }
    let mut events = record.events.clone();
    let mut retired: BTreeSet<_> = record
        .wallet
        .as_ref()
        .map(|w| w.retired.clone())
        .unwrap_or_default()
        .into_iter()
        .collect();
    if let Some(token) = record.wallet.as_ref().and_then(|w| w.token.clone()) {
        events.push(token);
    }
    for relay in &config.relays {
        if let Ok(found) = relay::query(relay, &record.zap.recipient).await {
            events.extend(found);
        }
    }
    let mut live = Vec::new();
    for (event, proofs, del) in candidates(&record, keys, events, &mut retired)? {
        if mint.verify(&proofs).is_err() {
            continue;
        }
        let Ok(states) = mint.states(&proofs).await else {
            continue;
        };
        if states.iter().all(|s| s == "UNSPENT") {
            live.push((event, proofs, del));
        } else if states.iter().any(|s| s == "SPENT") {
            retired.insert(event.id.to_hex());
        }
    }
    live.retain(|(e, _, _)| !retired.contains(&e.id.to_hex()));
    if live.len() != 1 {
        db.wallet(id, None, vec![], retired.into_iter().collect())?;
        return Ok("awaiting-peer");
    }
    let (token, proofs, del) = live.pop().ok_or("missing_token")?;
    retired.extend(del);
    Ok(
        if db.wallet(id, Some(token), proofs, retired.into_iter().collect())? {
            "complete"
        } else {
            "awaiting-peer"
        },
    )
}

pub(super) fn spend_events(record: &Record, proofs: &[Proof], keys: &Keys) -> Result<Vec<Event>> {
    use nostr::prelude::{EventBuilder, FinalizeEvent, Kind, Tag, Timestamp};
    let original = record
        .events
        .iter()
        .find(|e| e.kind.as_u16() == 7375)
        .ok_or("missing_token")?;
    let spend = record.spend.as_ref().ok_or("missing_spend")?;
    let encrypt = |v: Value| {
        nip44::encrypt(
            keys.secret_key(),
            &keys.public_key(),
            v.to_string(),
            nip44::Version::V2,
        )
        .map_err(|_| "encryption_failed")
    };
    let sign = |kind, content, tags: Vec<Tag>| {
        EventBuilder::new(Kind::from(kind), content)
            .tags(tags)
            .custom_created_at(Timestamp::from_secs(original.created_at.as_secs() + 1))
            .finalize(keys)
            .map_err(|_| "signing_failed")
    };
    let token = sign(
        7375_u16,
        encrypt(
            json!({"mint": record.zap.mint, "unit":"sat", "proofs":proofs,"del":[original.id.to_hex()]}),
        )?,
        vec![],
    )?;
    let deletion = sign(
        5,
        String::new(),
        vec![
            Tag::parse(["e", &original.id.to_hex()]).map_err(|_| "invalid_deletion")?,
            Tag::parse(["k", "7375"]).map_err(|_| "invalid_deletion")?,
        ],
    )?;
    let history = sign(
        7376,
        encrypt(json!([
            ["direction", "out"],
            [
                "amount",
                spend
                    .amount
                    .checked_add(spend.plan.plan.fee)
                    .ok_or("invalid_amount")?
                    .to_string()
            ],
            ["unit", "sat"],
            ["e", original.id.to_hex(), "", "destroyed"],
            ["e", token.id.to_hex(), "", "created"]
        ]))?,
        vec![],
    )?;
    Ok(vec![token, deletion, history])
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::prelude::{EventBuilder, FinalizeEvent, Kind, Tag};

    fn fixture() -> (Record, Keys, Proof) {
        let config = super::super::tests::fixture();
        let keys = Keys::parse(&config.key_hex).unwrap();
        let zap = protocol::validate(&config).unwrap();
        let proof = super::super::tests::output(&zap, "wallet-original");
        let events = protocol::wallet_events(&zap, &[proof.clone()], &keys).unwrap();
        let record = Record {
            zap,
            plan: super::super::Plan {
                material: "private".into(),
                outputs: vec![],
                fee: 0,
            },
            credit: Some(16),
            events: events.clone(),
            published: vec![],
            origin: Some("local".into()),
            wallet: Some(super::super::Wallet {
                token: Some(events[0].clone()),
                proofs: vec![proof.clone()],
                retired: vec![],
            }),
            spend: None,
        };
        (record, keys, proof)
    }
    fn token(keys: &Keys, body: Value) -> Event {
        let content = nip44::encrypt(
            keys.secret_key(),
            &keys.public_key(),
            body.to_string(),
            nip44::Version::V2,
        )
        .unwrap();
        EventBuilder::new(Kind::from(7375), content)
            .finalize(keys)
            .unwrap()
    }
    fn deletion(keys: &Keys, id: &str, kind: &str) -> Event {
        EventBuilder::new(Kind::from(5), "")
            .tags([
                Tag::parse(["e", id]).unwrap(),
                Tag::parse(["k", kind]).unwrap(),
            ])
            .finalize(keys)
            .unwrap()
    }
    #[test]
    fn signed_replacement_requires_owner_ancestry_unit_unique_proofs_and_bounded_value() {
        let (record, keys, mut proof) = fixture();
        proof.amount = 8.into();
        let valid = json!({"mint":record.zap.mint, "unit":"sat", "del":[record.events[0].id.to_hex()], "proofs":[proof]});
        assert_eq!(
            candidates(
                &record,
                &keys,
                vec![token(&keys, valid.clone())],
                &mut BTreeSet::new()
            )
            .unwrap()
            .len(),
            1
        );
        for fault in [
            "mint",
            "unit",
            "ancestry",
            "duplicate",
            "value",
            "signature",
            "owner",
            "encryption",
            "history",
        ] {
            let mut body = valid.clone();
            match fault {
                "mint" => body["mint"] = json!("http://127.0.0.1:9999"),
                "unit" => body["unit"] = json!("usd"),
                "ancestry" => body["del"] = json!([]),
                "duplicate" => body["proofs"] = json!([proof, proof]),
                "value" => body["proofs"][0]["amount"] = json!(32),
                _ => (),
            }
            let mut event = token(&keys, body);
            match fault {
                "signature" => event.content.push('x'),
                "owner" => event = token(&Keys::generate(), valid.clone()),
                "encryption" => {
                    event = EventBuilder::new(Kind::from(7375), "invalid")
                        .finalize(&keys)
                        .unwrap()
                }
                "history" => event = record.events[1].clone(),
                _ => (),
            }
            assert!(
                candidates(&record, &keys, vec![event], &mut BTreeSet::new())
                    .unwrap()
                    .is_empty(),
                "{fault}"
            );
        }
    }
    #[test]
    fn deletion_before_token_is_persisted_and_survives_restart() {
        let (record, keys, proof) = fixture();
        let replacement = token(
            &keys,
            json!({"mint": record.zap.mint,"unit":"sat","del":[record.events[0].id.to_hex()],"proofs":[proof]}),
        );
        let mut retired = BTreeSet::new();
        let deleted = deletion(&keys, &replacement.id.to_hex(), "7375");
        candidates(&record, &keys, vec![deleted], &mut retired).unwrap();
        assert!(retired.contains(&replacement.id.to_hex()));
        let path =
            std::env::temp_dir().join(format!("cdk-tombstone-{}.sqlite", uuid::Uuid::new_v4()));
        let mut db = Journal::open(&path).unwrap();
        db.reserve(&record).unwrap();
        db.wallet(&record.zap.id, None, vec![], retired.into_iter().collect())
            .unwrap();
        drop(db);
        let mut db = Journal::open(&path).unwrap();
        let saved = db.get(&record.zap.id).unwrap().unwrap();
        let mut retired = saved
            .wallet
            .as_ref()
            .unwrap()
            .retired
            .clone()
            .into_iter()
            .collect();
        assert!(
            candidates(&saved, &keys, vec![replacement.clone()], &mut retired)
                .unwrap()
                .is_empty()
        );
        assert!(
            db.wallet(&record.zap.id, Some(replacement), vec![proof], vec![])
                .is_err()
        );
        assert_eq!(db.get(&record.zap.id).unwrap().unwrap().credit, Some(16));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn forged_or_wrong_kind_deletion_cannot_retire_wallet_tokens() {
        let (record, keys, _) = fixture();
        for e in [
            deletion(&Keys::generate(), &record.events[0].id.to_hex(), "7375"),
            deletion(&keys, &record.events[0].id.to_hex(), "7376"),
        ] {
            let mut retired = BTreeSet::new();
            let found = candidates(
                &record,
                &keys,
                vec![record.events[0].clone(), e],
                &mut retired,
            )
            .unwrap();
            assert_eq!(found.len(), 1);
            assert!(retired.is_empty());
        }
    }
}
