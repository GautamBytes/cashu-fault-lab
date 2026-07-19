use std::str::FromStr;

use cdk::nuts::PaymentRequest;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileCapability {
    pub name: String,
    pub roles: Vec<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterCapabilities {
    pub implementation: String,
    pub version: String,
    pub nuts: Vec<u16>,
    pub transports: Vec<String>,
    pub evidence_tier: String,
    pub encodings: Vec<String>,
    pub profiles: Vec<ProfileCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum CompatibilityEvidence {
    ExpectedFailure { code: String, reason: String },
}

pub fn capabilities() -> AdapterCapabilities {
    AdapterCapabilities {
        implementation: "cdk".to_owned(),
        version: "0.17.3".to_owned(),
        nuts: vec![18, 26],
        transports: vec!["http".to_owned(), "nostr".to_owned()],
        evidence_tier: "T0".to_owned(),
        encodings: vec!["creqA".to_owned(), "creqB".to_owned()],
        profiles: vec![
            ProfileCapability {
                name: "legacy-nut18".to_owned(),
                roles: vec!["sender".to_owned(), "receiver".to_owned()],
                status: "supported".to_owned(),
                reason: None,
            },
            ProfileCapability {
                name: "delivery-v1".to_owned(),
                roles: vec!["sender".to_owned(), "receiver".to_owned()],
                status: "unsupported".to_owned(),
                reason: Some(
                    "CDK does not implement the experimental receipt/idempotency profile"
                        .to_owned(),
                ),
            },
            ProfileCapability {
                name: "nut26-nostr".to_owned(),
                roles: vec!["sender".to_owned(), "receiver".to_owned()],
                status: "supported".to_owned(),
                reason: None,
            },
        ],
    }
}

pub fn decode_request(encoded: &str) -> Result<PaymentRequest, String> {
    PaymentRequest::from_str(encoded).map_err(|_| "payment request decoding failed".to_owned())
}

pub fn nut26_nostr_mapping_evidence() -> CompatibilityEvidence {
    CompatibilityEvidence::ExpectedFailure {
        code: "NUT26_NIP_MAPPING_MISMATCH".to_owned(),
        reason: "NUT-26 defines NIP-04/raw-key transport while NUT-18 advertises NIP-17/nprofile"
            .to_owned(),
    }
}
