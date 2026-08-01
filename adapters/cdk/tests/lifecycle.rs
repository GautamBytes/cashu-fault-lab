use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use bitcoin::hashes::{Hash, sha256};
use cashu_fault_lab_cdk_adapter::{
    lifecycle::{
        LifecycleBalances, LifecycleEngine, LifecycleExecution, LifecycleInput, LifecycleKind,
        LifecyclePhase, LifecycleProofView, LifecycleRuntimeCapabilities, LifecycleWalletPort,
        LifecycleWalletView, NativeCdkLifecycleWallet,
    },
    lifecycle_store::LifecycleStore,
    server::router_with_lifecycle,
};
use tower::ServiceExt;

static NEXT_DATABASE: AtomicUsize = AtomicUsize::new(0);

fn database_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "cashu-fault-lab-cdk-lifecycle-{name}-{}-{}.sqlite",
        std::process::id(),
        NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn input(operation_id: &str, kind: LifecycleKind) -> LifecycleInput {
    LifecycleInput {
        operation_id: operation_id.to_owned(),
        kind,
        mint: "http://127.0.0.1:3338".to_owned(),
        unit: "sat".to_owned(),
        amount: matches!(
            kind,
            LifecycleKind::Mint | LifecycleKind::Swap | LifecycleKind::Send
        )
        .then_some(8),
        method: (kind == LifecycleKind::Mint).then(|| "bolt11".to_owned()),
        recipient: (kind == LifecycleKind::Send).then(|| "receiver".to_owned()),
        secret: matches!(kind, LifecycleKind::Receive | LifecycleKind::Melt)
            .then(|| "secret-request-material-canary".to_owned()),
        prefer_async: None,
        target_operation_id: (kind == LifecycleKind::Reconcile)
            .then(|| "BBBBBBBBBBBBBBBBBBBBBA".to_owned()),
    }
}

#[derive(Default)]
struct RecordingWallet {
    executions: AtomicUsize,
    recoveries: AtomicUsize,
    first_ambiguous: bool,
    advertised_operations: Option<Vec<&'static str>>,
}

struct ResetFailWallet;

#[async_trait]
impl LifecycleWalletPort for ResetFailWallet {
    async fn reset(&self, _seed: &str) -> Result<(), &'static str> {
        Err("wallet_reset_failed")
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        LifecycleExecution::succeeded(request.amount, "observed")
    }

    async fn recover(
        &self,
        _request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        LifecycleExecution::recovery_blocked("not_used")
    }
}

struct ResetOrderWallet {
    execute_started: tokio::sync::Notify,
    allow_execute: tokio::sync::Notify,
    resets: AtomicUsize,
}

struct OversizedWallet;

#[async_trait]
impl LifecycleWalletPort for OversizedWallet {
    async fn reset(&self, _seed: &str) -> Result<(), &'static str> {
        Ok(())
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        LifecycleExecution::succeeded(request.amount, "observed")
    }

    async fn recover(
        &self,
        _request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        LifecycleExecution::recovery_blocked("not_used")
    }

    async fn wallet(&self) -> Result<LifecycleWalletView, &'static str> {
        Ok(LifecycleWalletView {
            wallet_id: "cdk".to_owned(),
            mint: "http://127.0.0.1:3338/".to_owned(),
            unit: "sat".to_owned(),
            balances: LifecycleBalances {
                available: 0,
                reserved: 0,
                recoverable: 0,
            },
            proofs: (0..10_001)
                .map(|index| LifecycleProofView {
                    proof_id: format!("{index:064x}"),
                    state: "UNSPENT".to_owned(),
                })
                .collect(),
        })
    }
}

#[async_trait]
impl LifecycleWalletPort for ResetOrderWallet {
    async fn reset(&self, _seed: &str) -> Result<(), &'static str> {
        self.resets.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        self.execute_started.notify_one();
        self.allow_execute.notified().await;
        LifecycleExecution::succeeded(request.amount, "observed")
    }

    async fn recover(
        &self,
        _request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        LifecycleExecution::recovery_blocked("not_used")
    }
}

#[async_trait]
impl LifecycleWalletPort for RecordingWallet {
    async fn reset(&self, _seed: &str) -> Result<(), &'static str> {
        Ok(())
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        self.executions.fetch_add(1, Ordering::SeqCst);
        if self.first_ambiguous {
            LifecycleExecution::ambiguous("dependency_response_lost")
        } else {
            LifecycleExecution::succeeded(request.amount, format!("{}_observed", request.kind))
        }
    }

    async fn recover(
        &self,
        request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        self.recoveries.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(20)).await;
        LifecycleExecution::succeeded(request.amount, format!("{}_reconciled", request.kind))
    }

    async fn capabilities(&self) -> Result<LifecycleRuntimeCapabilities, &'static str> {
        Ok(LifecycleRuntimeCapabilities {
            operations: self.advertised_operations.clone().unwrap_or_else(|| {
                vec![
                    "mint",
                    "swap",
                    "send",
                    "receive",
                    "melt",
                    "restore",
                    "reconcile",
                ]
            }),
            nuts: vec![3, 4, 5, 7, 8, 9, 13, 23],
            recovery: vec!["quote_state", "proof_state", "nut09_restore", "nut13_seed"],
        })
    }
}

#[tokio::test]
async fn identity_and_secret_material_survive_restart_encrypted() {
    let path = database_path("identity");
    let key = [7_u8; 32];
    let wallet = Arc::new(RecordingWallet::default());
    let store = Arc::new(LifecycleStore::open(&path, key).expect("open lifecycle store"));
    let engine = LifecycleEngine::new(store.clone(), wallet);

    engine
        .reset("raw-wallet-seed-canary")
        .await
        .expect("reset lifecycle state");
    let expected_seed_hash =
        sha256::Hash::hash(b"cashu-fault-lab/cdk-lifecycle-seed-hash-v1\0raw-wallet-seed-canary")
            .to_string();
    assert_eq!(
        store.seed_hash().expect("read seed hash"),
        Some(expected_seed_hash)
    );
    let operation = engine
        .start(input("AAAAAAAAAAAAAAAAAAAAAA", LifecycleKind::Receive))
        .await
        .expect("start receive");
    assert_eq!(operation.phase, LifecyclePhase::Succeeded);
    drop(engine);
    drop(store);

    let reopened = LifecycleStore::open(&path, key).expect("reopen lifecycle store");
    let persisted = reopened
        .get("AAAAAAAAAAAAAAAAAAAAAA")
        .expect("read operation")
        .expect("operation persisted");
    assert_eq!(persisted.operation_id, operation.operation_id);
    assert_eq!(persisted.intent_hash, operation.intent_hash);

    let database = std::fs::read(path).expect("read sqlite file");
    assert!(!database.starts_with(b"SQLite format 3"));
    assert!(
        !database
            .windows(b"raw-wallet-seed-canary".len())
            .any(|value| value == b"raw-wallet-seed-canary")
    );
    assert!(
        !database
            .windows(b"secret-request-material-canary".len())
            .any(|value| value == b"secret-request-material-canary")
    );
}

#[test]
fn reset_rejects_seeds_over_the_contract_limit() {
    let path = database_path("seed-limit");
    let store = LifecycleStore::open(path, [8_u8; 32]).expect("open lifecycle store");
    assert_eq!(
        store.reset(&"s".repeat(257)),
        Err("lifecycle seed is invalid".to_owned())
    );
}

#[tokio::test]
async fn operation_identity_uses_the_canonical_mint_url() {
    let path = database_path("canonical-mint");
    let store = Arc::new(LifecycleStore::open(path, [10_u8; 32]).expect("open lifecycle store"));
    let engine = LifecycleEngine::new(store, Arc::new(RecordingWallet::default()));
    let operation = engine
        .start(input("FFFFFFFFFFFFFFFFFFFFFA", LifecycleKind::Receive))
        .await
        .expect("start operation");
    assert_eq!(operation.mint, "http://127.0.0.1:3338/");
}

#[tokio::test]
async fn concurrent_resume_claims_one_recovery() {
    let path = database_path("claim");
    let wallet = Arc::new(RecordingWallet {
        first_ambiguous: true,
        ..Default::default()
    });
    let store = Arc::new(LifecycleStore::open(path, [9_u8; 32]).expect("open lifecycle store"));
    let engine = Arc::new(LifecycleEngine::new(store, wallet.clone()));

    let started = engine
        .start(input("AAAAAAAAAAAAAAAAAAAAAA", LifecycleKind::Swap))
        .await
        .expect("start swap");
    assert_eq!(started.phase, LifecyclePhase::Ambiguous);

    let left = tokio::spawn({
        let engine = engine.clone();
        async move { engine.resume("AAAAAAAAAAAAAAAAAAAAAA").await }
    });
    let right = tokio::spawn({
        let engine = engine.clone();
        async move { engine.resume("AAAAAAAAAAAAAAAAAAAAAA").await }
    });
    let (left, right) = tokio::join!(left, right);

    assert_eq!(
        left.expect("left task").expect("left resume").phase,
        LifecyclePhase::Succeeded
    );
    assert_eq!(
        right.expect("right task").expect("right resume").phase,
        LifecyclePhase::Succeeded
    );
    assert_eq!(wallet.executions.load(Ordering::SeqCst), 1);
    assert_eq!(wallet.recoveries.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn repeated_start_recovers_every_existing_in_flight_phase() {
    let path = database_path("repeated-start");
    let wallet = Arc::new(RecordingWallet {
        first_ambiguous: true,
        ..Default::default()
    });
    let store = Arc::new(LifecycleStore::open(path, [15_u8; 32]).expect("open lifecycle store"));
    let engine = LifecycleEngine::new(store.clone(), wallet.clone());

    for (index, phase) in [
        LifecyclePhase::Prepared,
        LifecyclePhase::Submitted,
        LifecyclePhase::Reconciling,
    ]
    .into_iter()
    .enumerate()
    {
        let operation_id = format!("{:0>21}{}", index + 20, ['A', 'Q', 'g'][index]);
        let request = input(&operation_id, LifecycleKind::Receive);
        let mut operation = engine.start(request.clone()).await.expect("first start");
        assert_eq!(operation.phase, LifecyclePhase::Ambiguous);
        operation.phase = phase;
        store.put(&operation, None).expect("set crash phase");

        let resumed = engine.start(request).await.expect("repeated start");
        assert_eq!(resumed.phase, LifecyclePhase::Succeeded);
    }

    assert_eq!(wallet.executions.load(Ordering::SeqCst), 3);
    assert_eq!(wallet.recoveries.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn reopening_store_does_not_steal_a_live_claim() {
    let path = database_path("reopen-claim");
    let store =
        Arc::new(LifecycleStore::open(&path, [17_u8; 32]).expect("open first lifecycle store"));
    let engine = LifecycleEngine::new(store.clone(), Arc::new(RecordingWallet::default()));
    engine
        .start(input("CCCCCCCCCCCCCCCCCCCCCA", LifecycleKind::Receive))
        .await
        .expect("create operation");
    assert!(
        store
            .try_claim("CCCCCCCCCCCCCCCCCCCCCA")
            .expect("first claim")
    );

    let reopened = LifecycleStore::open(&path, [17_u8; 32]).expect("open second lifecycle store");
    assert!(
        !reopened
            .try_claim("CCCCCCCCCCCCCCCCCCCCCA")
            .expect("competing claim")
    );
}

#[tokio::test]
async fn reset_claim_is_mutually_exclusive_across_store_instances() {
    let path = database_path("cross-store-reset");
    let first =
        Arc::new(LifecycleStore::open(&path, [18_u8; 32]).expect("open first lifecycle store"));
    let engine = LifecycleEngine::new(first.clone(), Arc::new(RecordingWallet::default()));
    engine
        .start(input("JJJJJJJJJJJJJJJJJJJJJA", LifecycleKind::Receive))
        .await
        .expect("create operation");
    assert!(
        first
            .try_claim("JJJJJJJJJJJJJJJJJJJJJA")
            .expect("claim operation")
    );
    let second = LifecycleStore::open(&path, [18_u8; 32]).expect("open second lifecycle store");
    assert!(!second.try_claim_reset().expect("blocked reset claim"));

    first
        .release("JJJJJJJJJJJJJJJJJJJJJA")
        .expect("release operation");
    assert!(second.try_claim_reset().expect("claim reset"));
    assert!(
        !first
            .try_claim("JJJJJJJJJJJJJJJJJJJJJA")
            .expect("blocked operation claim")
    );
    second.release_reset().expect("release reset");
}

#[tokio::test]
async fn start_rejects_operations_not_advertised_by_the_wallet() {
    let path = database_path("capability-gate");
    let wallet = Arc::new(RecordingWallet {
        advertised_operations: Some(vec!["mint", "receive", "melt", "restore"]),
        ..Default::default()
    });
    let store = Arc::new(LifecycleStore::open(path, [19_u8; 32]).expect("open lifecycle store"));
    let engine = LifecycleEngine::new(store.clone(), wallet.clone());

    for (index, kind) in [
        LifecycleKind::Swap,
        LifecycleKind::Send,
        LifecycleKind::Reconcile,
    ]
    .into_iter()
    .enumerate()
    {
        let operation_id = format!("{:0>21}{}", index + 30, ['A', 'Q', 'g'][index]);
        let error = engine
            .start(input(&operation_id, kind))
            .await
            .expect_err("unsupported operation must not execute");
        assert_eq!(error, "lifecycle operation is not applicable");
        assert!(
            store
                .get(&operation_id)
                .expect("lookup operation")
                .is_none()
        );
    }
    assert_eq!(wallet.executions.load(Ordering::SeqCst), 0);
}

#[test]
fn native_cdk_policy_excludes_unbound_swap_send_and_reconcile() {
    for kind in [
        LifecycleKind::Swap,
        LifecycleKind::Send,
        LifecycleKind::Reconcile,
    ] {
        assert!(!NativeCdkLifecycleWallet::operation_bound(kind));
    }
    for kind in [
        LifecycleKind::Mint,
        LifecycleKind::Receive,
        LifecycleKind::Melt,
        LifecycleKind::Restore,
    ] {
        assert!(NativeCdkLifecycleWallet::operation_bound(kind));
    }
}

#[tokio::test]
async fn native_cdk_rejects_unbound_operations_before_wallet_side_effects() {
    let wallet = NativeCdkLifecycleWallet::new(
        "http://127.0.0.1:3338",
        "sat",
        database_path("native-policy"),
        "k".repeat(64),
    )
    .expect("construct native wallet");
    for kind in [
        LifecycleKind::Swap,
        LifecycleKind::Send,
        LifecycleKind::Reconcile,
    ] {
        let result = wallet.execute(&input("IIIIIIIIIIIIIIIIIIIIIA", kind)).await;
        assert_eq!(result.evidence_code(), Some("operation_not_applicable"));
    }
}

#[test]
fn native_cdk_never_attributes_aggregate_saga_counts_to_receive() {
    assert_eq!(
        NativeCdkLifecycleWallet::aggregate_recovery_phase(LifecycleKind::Receive),
        LifecyclePhase::RecoveryBlocked
    );
}

#[tokio::test]
async fn failed_wallet_reset_preserves_the_existing_journal() {
    let path = database_path("reset-failure");
    let store = Arc::new(LifecycleStore::open(path, [21_u8; 32]).expect("open lifecycle store"));
    let initial = LifecycleEngine::new(store.clone(), Arc::new(RecordingWallet::default()));
    initial
        .start(input("DDDDDDDDDDDDDDDDDDDDDA", LifecycleKind::Receive))
        .await
        .expect("create operation");
    let failing = LifecycleEngine::new(store.clone(), Arc::new(ResetFailWallet));

    assert_eq!(
        failing.reset("replacement-seed").await,
        Err("wallet_reset_failed".to_owned())
    );
    assert!(
        store
            .get("DDDDDDDDDDDDDDDDDDDDDA")
            .expect("read operation")
            .is_some()
    );
}

#[tokio::test]
async fn reset_waits_for_an_in_flight_operation() {
    let path = database_path("reset-order");
    let store = Arc::new(LifecycleStore::open(path, [23_u8; 32]).expect("open lifecycle store"));
    let wallet = Arc::new(ResetOrderWallet {
        execute_started: tokio::sync::Notify::new(),
        allow_execute: tokio::sync::Notify::new(),
        resets: AtomicUsize::new(0),
    });
    let engine = Arc::new(LifecycleEngine::new(store, wallet.clone()));
    let start = tokio::spawn({
        let engine = engine.clone();
        async move {
            engine
                .start(input("EEEEEEEEEEEEEEEEEEEEEA", LifecycleKind::Receive))
                .await
        }
    });
    wallet.execute_started.notified().await;
    let reset = tokio::spawn({
        let engine = engine.clone();
        async move { engine.reset("replacement-seed").await }
    });
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(wallet.resets.load(Ordering::SeqCst), 0);
    wallet.allow_execute.notify_one();

    start.await.expect("start task").expect("start operation");
    reset.await.expect("reset task").expect("reset operation");
    assert_eq!(wallet.resets.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_lifecycle_json_returns_a_stable_contract_error() {
    let path = database_path("malformed-json");
    let store = Arc::new(LifecycleStore::open(path, [25_u8; 32]).expect("open lifecycle store"));
    let app = router_with_lifecycle(
        "control-token",
        None,
        Some(Arc::new(LifecycleEngine::new(
            store,
            Arc::new(RecordingWallet::default()),
        ))),
    )
    .expect("build router");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/operations")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("stable json");
    assert_eq!(value["code"], "LIFECYCLE_SCHEMA_INVALID");

    let reset = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/reset")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(reset.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = to_bytes(reset.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("stable json");
    assert_eq!(value["code"], "LIFECYCLE_SCHEMA_INVALID");
}

#[tokio::test]
async fn wallet_route_rejects_more_than_ten_thousand_proofs() {
    let path = database_path("proof-cap");
    let store = Arc::new(LifecycleStore::open(path, [27_u8; 32]).expect("open lifecycle store"));
    let app = router_with_lifecycle(
        "control-token",
        None,
        Some(Arc::new(LifecycleEngine::new(
            store,
            Arc::new(OversizedWallet),
        ))),
    )
    .expect("build router");
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/lifecycle/wallet")
                .header("authorization", "Bearer control-token")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::INSUFFICIENT_STORAGE);
}

#[tokio::test]
async fn unsupported_operation_returns_not_applicable_over_http() {
    let path = database_path("http-na");
    let wallet = Arc::new(RecordingWallet {
        advertised_operations: Some(vec!["mint", "receive", "melt", "restore"]),
        ..Default::default()
    });
    let store = Arc::new(LifecycleStore::open(path, [29_u8; 32]).expect("open lifecycle store"));
    let app = router_with_lifecycle(
        "control-token",
        None,
        Some(Arc::new(LifecycleEngine::new(store, wallet))),
    )
    .expect("build router");
    let request = serde_json::to_vec(&input("GGGGGGGGGGGGGGGGGGGGGA", LifecycleKind::Swap))
        .expect("encode request");
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/operations")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from(request))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    let body = to_bytes(response.into_body(), 4096).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(value["status"], "N/A");
}

#[tokio::test]
async fn lifecycle_body_override_does_not_widen_legacy_routes() {
    let path = database_path("body-limits");
    let store = Arc::new(LifecycleStore::open(path, [31_u8; 32]).expect("open lifecycle store"));
    let app = router_with_lifecycle(
        "control-token",
        None,
        Some(Arc::new(LifecycleEngine::new(
            store,
            Arc::new(RecordingWallet::default()),
        ))),
    )
    .expect("build router");
    let legacy = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/reset")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"seed":"{}"}}"#,
                    "x".repeat(20_000)
                )))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(legacy.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let mut lifecycle_input = input("HHHHHHHHHHHHHHHHHHHHHA", LifecycleKind::Receive);
    lifecycle_input.secret = Some("t".repeat(20_000));
    let lifecycle = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/operations")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&lifecycle_input).expect("encode lifecycle request"),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(lifecycle.status(), StatusCode::OK);
}

#[tokio::test]
async fn lifecycle_identity_digests_do_not_reuse_the_contract_digest() {
    let path = database_path("digests");
    let store = Arc::new(LifecycleStore::open(path, [33_u8; 32]).expect("open lifecycle store"));
    let app = router_with_lifecycle(
        "control-token",
        None,
        Some(Arc::new(LifecycleEngine::new(
            store,
            Arc::new(RecordingWallet::default()),
        ))),
    )
    .expect("build router");
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/lifecycle/capabilities")
                .header("authorization", "Bearer control-token")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let body = to_bytes(response.into_body(), 16_384).await.expect("body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
    let source = value["implementation"]["sourceDigest"]
        .as_str()
        .expect("source digest");
    let build = value["implementation"]["buildDigest"]
        .as_str()
        .expect("build digest");
    assert_ne!(
        source,
        cashu_fault_lab_wallet_lifecycle_contract::SPEC_DIGEST
    );
    assert_ne!(
        build,
        cashu_fault_lab_wallet_lifecycle_contract::SPEC_DIGEST
    );
    assert_ne!(source, build);
}

#[test]
fn melt_recovery_keeps_unverified_amount_fee_and_change_absent() {
    let recovered = LifecycleExecution::melt_recovered(12);
    assert_eq!(recovered.amount(), None);
    assert_eq!(recovered.fee_reserve(), Some(12));
    assert_eq!(recovered.actual_fee(), None);
    assert_eq!(recovered.change(), None);
}

#[tokio::test]
async fn lifecycle_engine_operations_emit_sanitized_observations() {
    let path = database_path("operations");
    let wallet = Arc::new(RecordingWallet::default());
    let store = Arc::new(LifecycleStore::open(path, [11_u8; 32]).expect("open lifecycle store"));
    let engine = LifecycleEngine::new(store, wallet);
    let kinds = [
        LifecycleKind::Mint,
        LifecycleKind::Swap,
        LifecycleKind::Melt,
        LifecycleKind::Send,
        LifecycleKind::Receive,
        LifecycleKind::Restore,
        LifecycleKind::Reconcile,
    ];

    for (index, kind) in kinds.into_iter().enumerate() {
        let operation_id = format!("AAAAAAAAAAAAAAAAAAAAA{}", ['A', 'Q', 'g', 'w'][index % 4]);
        let mut request = input(&operation_id, kind);
        request.operation_id = format!("{:0>21}{}", index, ['A', 'Q', 'g', 'w'][index % 4]);
        let operation = engine.start(request).await.expect("execute operation");
        assert_eq!(operation.phase, LifecyclePhase::Succeeded);
    }

    let evidence = engine.evidence().expect("read evidence");
    assert_eq!(evidence.len(), kinds.len());
    for (observation, kind) in evidence.iter().zip(kinds) {
        assert_eq!(observation.event, format!("{kind}_observed"));
        assert_eq!(observation.data_hash.len(), 64);
        assert!(!observation.data_hash.contains("secret"));
    }
}

#[tokio::test]
async fn lifecycle_routes_are_authenticated_and_contract_shaped() {
    let path = database_path("routes");
    let store = Arc::new(LifecycleStore::open(path, [13_u8; 32]).expect("open lifecycle store"));
    let engine = Arc::new(LifecycleEngine::new(
        store,
        Arc::new(RecordingWallet::default()),
    ));
    let app = router_with_lifecycle("control-token", None, Some(engine)).expect("build router");

    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/lifecycle/capabilities")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/lifecycle/capabilities")
                .header("authorization", "Bearer control-token")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 16_384)
        .await
        .expect("bounded body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("json response");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["implementation"]["id"], "cdk");
    assert_eq!(value["durability"], "restart_safe");

    let invalid = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/operations")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"operationId":"AAAAAAAAAAAAAAAAAAAAAA","kind":"mint","mint":"http://127.0.0.1:3338","unit":"sat","amount":8,"method":"bolt11","token":"must-not-be-accepted"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
}
