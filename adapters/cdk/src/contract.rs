use std::str::FromStr;

use bitcoin::hashes::{Hash, sha256};
use cdk::nuts::PaymentRequest;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImplementationIdentity {
    pub id: String,
    pub version: String,
    pub language: String,
    pub runtime: String,
    pub source_digest: String,
    pub build_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleEvidence {
    pub tier: String,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleCapability {
    pub transports: Vec<String>,
    pub profiles: Vec<String>,
    pub durability: String,
    pub evidence: RoleEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterRoles {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<RoleCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<RoleCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MintIdentity {
    pub id: String,
    pub implementation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterContractMetadata {
    pub api_version: u8,
    pub schema_version: u8,
    pub spec_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterCapabilities {
    pub schema_version: u8,
    pub implementation: ImplementationIdentity,
    pub roles: AdapterRoles,
    pub nuts: Vec<u16>,
    pub encodings: Vec<String>,
    pub mints: Vec<MintIdentity>,
    pub contract: AdapterContractMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum CompatibilityEvidence {
    ExpectedFailure { code: String, reason: String },
}

fn identity() -> ImplementationIdentity {
    let id = "cdk";
    let version = "0.17.3";
    let language = "rust";
    let runtime = "native";
    let value = format!("{id}\0{version}\0{language}\0{runtime}");
    let digest = |domain: &str| {
        format!(
            "sha256:{}",
            sha256::Hash::hash(format!("cashu-fault-lab/{domain}/v1\0{value}").as_bytes())
        )
    };
    ImplementationIdentity {
        id: id.to_owned(),
        version: version.to_owned(),
        language: language.to_owned(),
        runtime: runtime.to_owned(),
        source_digest: digest("source"),
        build_digest: digest("build"),
    }
}

fn contract_metadata() -> AdapterContractMetadata {
    AdapterContractMetadata {
        api_version: 1,
        schema_version: 2,
        spec_digest: format!(
            "sha256:{}",
            sha256::Hash::hash(include_bytes!("../../../spec/openapi.yaml"))
        ),
    }
}

fn role(
    transports: &[&str],
    profiles: &[&str],
    durability: &str,
    tier: &str,
    sources: &[&str],
) -> RoleCapability {
    RoleCapability {
        transports: transports.iter().map(ToString::to_string).collect(),
        profiles: profiles.iter().map(ToString::to_string).collect(),
        durability: durability.to_owned(),
        evidence: RoleEvidence {
            tier: tier.to_owned(),
            sources: sources.iter().map(ToString::to_string).collect(),
        },
    }
}

pub fn capabilities() -> AdapterCapabilities {
    AdapterCapabilities {
        schema_version: 2,
        implementation: identity(),
        roles: AdapterRoles {
            sender: Some(role(
                &["http", "nostr"],
                &["legacy-nut18", "nut26-nostr"],
                "process",
                "T0",
                &["adapter"],
            )),
            receiver: Some(role(
                &["http", "nostr"],
                &["legacy-nut18", "nut26-nostr"],
                "process",
                "T0",
                &["adapter"],
            )),
        },
        nuts: vec![18, 26],
        encodings: vec!["creqA".to_owned(), "creqB".to_owned()],
        mints: vec![],
        contract: contract_metadata(),
    }
}

pub fn funded_capabilities() -> AdapterCapabilities {
    AdapterCapabilities {
        schema_version: 2,
        implementation: identity(),
        roles: AdapterRoles {
            sender: Some(role(
                &["http"],
                &["delivery-v1"],
                "process",
                "T1",
                &["adapter", "runner", "transport"],
            )),
            receiver: None,
        },
        nuts: vec![3, 7, 18],
        encodings: vec!["creqA".to_owned(), "creqB".to_owned()],
        mints: vec![],
        contract: contract_metadata(),
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
