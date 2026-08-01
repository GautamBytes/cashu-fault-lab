//! Generated Cashu Fault Lab wallet lifecycle contract models.
//! Intended OpenAPI Generator target: rust
//! openapi-generator-cli: 7.15.0
//! specDigest: sha256:d30e9792e80ee1576528f23e633e4cd85ebe938bdf532f75671e7f7f26c92f27

pub const SPEC_DIGEST: &str = "sha256:d30e9792e80ee1576528f23e633e4cd85ebe938bdf532f75671e7f7f26c92f27";
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
