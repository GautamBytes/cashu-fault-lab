//! Generated Cashu Fault Lab wallet-doctor artifact contract.
//! specDigest: sha256:d9cd1c5bfc03e2a3b590b98ff2691d59257fcb842243cf66cd0a9c6b0431dd3a

pub const SPEC_DIGEST: &str = "sha256:d9cd1c5bfc03e2a3b590b98ff2691d59257fcb842243cf66cd0a9c6b0431dd3a";
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
