//! Generated Cashu Fault Lab adapter contract models.
//! Intended OpenAPI Generator target: rust
//! openapi-generator-cli: 7.15.0
//! specDigest: sha256:76c5f22e863481d2bc21d55080d7e20ecc6e2bbe3310164f801c4fedef3abc5d

pub const OPENAPI_GENERATOR: &str = "openapi-generator-cli";
pub const OPENAPI_GENERATOR_VERSION: &str = "7.15.0";
pub const SPEC_DIGEST: &str = "sha256:76c5f22e863481d2bc21d55080d7e20ecc6e2bbe3310164f801c4fedef3abc5d";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterContractMetadata {
    pub api_version: u32,
    pub schema_version: u32,
    pub spec_digest: &'static str,
}

pub const ADAPTER_CONTRACT: AdapterContractMetadata = AdapterContractMetadata {
    api_version: 1,
    schema_version: 2,
    spec_digest: SPEC_DIGEST,
};
