use super::*;
use nostr::prelude::{EventBuilder, FinalizeEvent, Kind, Tag};
use serde_json::json;
use std::path::PathBuf;

fn signed(kind: u16, tags: Vec<Vec<String>>, keys: &Keys) -> Event {
    EventBuilder::new(Kind::from(kind), "")
        .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
        .finalize(keys)
        .unwrap()
}
fn fixture() -> Config {
    let key_hex = format!("{:064x}", 1);
    let lock_hex = format!("{:064x}", 2);
    let keys = Keys::parse(&key_hex).unwrap();
    let lock = Keys::parse(&lock_hex).unwrap();
    let secret =
        json!(["P2PK", {"nonce":"test", "data":format!("02{}", lock.public_key().to_hex())}])
            .to_string();
    let p = json!({"id":"001234567890abcd", "amount":16, "secret":secret,
        "C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "dleq":{"e":format!("{:064x}",3),"s":format!("{:064x}",4),"r":format!("{:064x}",5)}});
    Config {
        database: PathBuf::from("unused.sqlite"),
        key_hex,
        lock_hex,
        info: signed(
            10019,
            vec![
                vec!["pubkey".into(), lock.public_key().to_hex()],
                vec!["mint".into(), "http://127.0.0.1:3338".into(), "sat".into()],
            ],
            &keys,
        ),
        event: signed(
            9321,
            vec![
                vec!["p".into(), keys.public_key().to_hex()],
                vec!["u".into(), "http://127.0.0.1:3338".into()],
                vec!["proof".into(), p.to_string()],
            ],
            &lock,
        ),
        relays: vec!["ws://127.0.0.1:4400".into()],
    }
}
fn output(zap: &Zap, secret: &str) -> Proof {
    let mut p = zap.proofs[0].clone();
    p.secret = secret.parse().unwrap();
    p
}
#[test]
fn signed_basic_profile_validates_and_does_not_trust_tampering() {
    let mut f = fixture();
    assert_eq!(protocol::validate(&f).unwrap().amount, 16);
    f.event.content = "tampered".to_owned();
    assert!(protocol::validate(&f).is_err());
}
#[test]
fn rejects_recipient_lock_unit_mint_and_duplicate_proof_changes() {
    for fault in [
        "recipient",
        "lock",
        "unit",
        "mint",
        "duplicate",
        "missing-dleq",
        "sig-all",
    ] {
        let mut f = fixture();
        let lock = Keys::parse(&f.lock_hex).unwrap();
        let mut tags: Vec<Vec<String>> =
            f.event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        match fault {
            "recipient" => tags[0][1] = lock.public_key().to_hex(),
            "lock" => f.lock_hex = format!("{:064x}", 7),
            "unit" => tags.push(vec!["unit".into(), "usd".into()]),
            "mint" => tags[1][1] = "http://127.0.0.1:9999".into(),
            "duplicate" => tags.push(tags[2].clone()),
            _ => {
                let mut proof: serde_json::Value = serde_json::from_str(&tags[2][1]).unwrap();
                if fault == "missing-dleq" {
                    proof.as_object_mut().unwrap().remove("dleq");
                } else {
                    let mut secret: serde_json::Value =
                        serde_json::from_str(proof["secret"].as_str().unwrap()).unwrap();
                    secret[1]["tags"] = json!([["sigflag", "SIG_ALL"]]);
                    proof["secret"] = json!(secret.to_string());
                }
                tags[2][1] = proof.to_string();
            }
        }
        f.event = signed(9321, tags, &lock);
        assert!(protocol::validate(&f).is_err(), "{fault}");
    }
}
#[test]
fn peer_requires_complete_signed_consistent_transition() {
    let f = fixture();
    let zap = protocol::validate(&f).unwrap();
    let keys = Keys::parse(&f.key_hex).unwrap();
    let proofs = vec![output(&zap, "new-output-secret")];
    let events = protocol::wallet_events(&zap, &proofs, &keys).unwrap();
    assert!(
        protocol::peer_candidate(&zap, 0, &keys, events.clone())
            .unwrap()
            .is_some()
    );
    assert!(
        protocol::peer_candidate(&zap, 1, &keys, events.clone())
            .unwrap()
            .is_none()
    );
    assert!(
        protocol::peer_candidate(&zap, 0, &keys, vec![events[1].clone()])
            .unwrap()
            .is_none()
    );
    let mut tampered = events.clone();
    tampered[0].content = "tampered".into();
    assert!(
        protocol::peer_candidate(&zap, 0, &keys, tampered)
            .unwrap()
            .is_none()
    );
    let other = protocol::wallet_events(&zap, &proofs, &keys).unwrap();
    assert!(
        protocol::peer_candidate(&zap, 0, &keys, [events.clone(), other].concat())
            .unwrap()
            .is_none()
    );
    let original = protocol::wallet_events(&zap, &zap.proofs, &keys).unwrap();
    assert!(
        protocol::peer_candidate(&zap, 0, &keys, original)
            .unwrap()
            .is_none()
    );
}
#[test]
fn journal_survives_restart_and_atomically_rejects_duplicate_outputs() {
    let f = fixture();
    let zap = protocol::validate(&f).unwrap();
    let keys = Keys::parse(&f.key_hex).unwrap();
    let path = std::env::temp_dir().join(format!("cdk-nutzap-{}.sqlite", uuid::Uuid::new_v4()));
    let proof = output(&zap, "wallet-output");
    let mut record = Record {
        zap,
        plan: Plan {
            material: "private-plan".into(),
            outputs: vec![],
            fee: 0,
        },
        credit: None,
        origin: None,
        events: vec![],
        published: vec![],
    };
    {
        let mut db = Journal::open(&path).unwrap();
        db.reserve(&record).unwrap();
    }
    {
        let mut db = Journal::open(&path).unwrap();
        assert_eq!(
            db.get(&record.zap.id).unwrap().unwrap().plan.material,
            "private-plan"
        );
        let events =
            protocol::wallet_events(&record.zap, std::slice::from_ref(&proof), &keys).unwrap();
        let saved = db
            .credit(
                &record,
                std::slice::from_ref(&proof),
                events.clone(),
                "local",
            )
            .unwrap();
        assert_eq!(saved.credit, Some(16));
        assert_eq!(
            db.credit(
                &record,
                std::slice::from_ref(&proof),
                events.clone(),
                "relay"
            )
            .unwrap()
            .origin
            .as_deref(),
            Some("local")
        );
        record.zap.id = "second-redemption".into();
        record.zap.proofs = vec![output(&record.zap, "second-input")];
        db.reserve(&record).unwrap();
        assert!(db.credit(&record, &[proof], events, "relay").is_err());
        assert_eq!(db.get(&record.zap.id).unwrap().unwrap().credit, None);
    }
    std::fs::remove_file(path).unwrap();
}
#[test]
fn rejects_remote_and_credentialed_endpoints() {
    for url in [
        "http://example.com",
        "https://127.0.0.1",
        "http://user:pass@127.0.0.1",
        "http://127.0.0.1/redirect",
        "http://127.0.0.1?query",
    ] {
        assert!(protocol::local_url(url, "http").is_err());
    }
}

#[test]
fn rejects_timestamp_that_cannot_be_incremented_safely() {
    let mut f = fixture();
    let keys = Keys::parse(&f.lock_hex).unwrap();
    f.event = EventBuilder::new(Kind::from(9321), "")
        .tags(f.event.tags.clone())
        .custom_created_at(nostr::prelude::Timestamp::from_secs(u64::MAX))
        .finalize(&keys)
        .unwrap();
    assert!(protocol::validate(&f).is_err());
}
