//! Generated Cashu Fault Lab wallet lifecycle contract models.
//! Intended OpenAPI Generator target: rust
//! openapi-generator-cli: 7.15.0
//! specDigest: sha256:2761a9c03bd5f82121c775fd597d96cb355740bc5e2e9e3aa2d2ecd05bb75349

pub const SPEC_DIGEST: &str = "sha256:2761a9c03bd5f82121c775fd597d96cb355740bc5e2e9e3aa2d2ecd05bb75349";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleOperationKind {
    Mint,
    Swap,
    Send,
    Receive,
    Melt,
    Restore,
    Reconcile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecyclePhase {
    Created,
    Prepared,
    Submitted,
    Ambiguous,
    Reconciling,
    Succeeded,
    FailedDefinitive,
    RecoveryBlocked,
}
