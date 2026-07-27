use cashu_fault_lab_cdk_adapter::{
    CompatibilityEvidence, capabilities, decode_request, funded_capabilities,
    nut26_nostr_mapping_evidence,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    name: String,
    encoded: String,
    expected_id: String,
}

fn vectors() -> Vec<Vector> {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/upstream-payment-requests.json"
    ))
    .expect("published vector file must be valid");
    serde_json::from_value(value["vectors"].clone()).expect("published vectors must be valid")
}

#[test]
fn publishes_honest_legacy_capabilities() {
    let value = capabilities();
    assert_eq!(value.schema_version, 2);
    assert_eq!(value.implementation.id, "cdk");
    assert_eq!(value.implementation.version, "0.17.3");
    assert_eq!(value.encodings, ["creqA", "creqB"]);
    let sender = value.roles.sender.expect("sender role must be declared");
    assert_eq!(sender.evidence.tier, "T0");
    assert!(!sender.profiles.contains(&"delivery-v1".to_owned()));
}

#[test]
fn does_not_claim_restart_durability_for_in_memory_funded_state() {
    let value = funded_capabilities();
    let sender = value
        .roles
        .sender
        .expect("funded sender role must be declared");
    assert_eq!(sender.durability, "process");
    assert!(
        !sender
            .evidence
            .sources
            .contains(&"durable_state".to_owned())
    );
}

#[test]
fn decodes_official_pinned_nut18_and_nut26_vectors() {
    let vectors = vectors();
    let legacy_vector = vectors
        .iter()
        .find(|vector| vector.name == "nut18-creqA-nip17")
        .expect("NUT-18 vector must exist");
    let legacy = decode_request(&legacy_vector.encoded).expect("NUT-18 vector must decode");
    assert_eq!(
        legacy.payment_id.as_deref(),
        Some(legacy_vector.expected_id.as_str())
    );
    assert_eq!(legacy.transports.len(), 1);

    let compact_vector = vectors
        .iter()
        .find(|vector| vector.name == "nut26-creqB-basic")
        .expect("NUT-26 vector must exist");
    let compact = decode_request(&compact_vector.encoded).expect("NUT-26 vector must decode");
    assert_eq!(
        compact.payment_id.as_deref(),
        Some(compact_vector.expected_id.as_str())
    );
    assert_eq!(
        compact
            .to_bech32_string()
            .expect("NUT-26 vector must re-encode"),
        compact_vector.encoded
    );
}

#[test]
fn does_not_normalize_the_known_nut26_nostr_mismatch() {
    assert!(matches!(
        nut26_nostr_mapping_evidence(),
        CompatibilityEvidence::ExpectedFailure { code, .. }
            if code == "NUT26_NIP_MAPPING_MISMATCH"
    ));
}
