//! Generated Cashu Fault Lab wallet-doctor artifact contract.
//! specDigest: sha256:2e972596094411d00ec09a3f2a0233f99cbfd69ab027a93e83e0409bab5a5e46

pub const SPEC_DIGEST: &str = "sha256:2e972596094411d00ec09a3f2a0233f99cbfd69ab027a93e83e0409bab5a5e46";
pub const CAPTURE_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureMetadata {
    pub captured_at: String,
    pub digest: String,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayEvidence {
    pub url: String,
    pub status: String,
    pub error: Option<String>,
    pub event_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactReference {
    pub schema_version: u32,
    pub kind: String,
    pub generated_from: String,
}
