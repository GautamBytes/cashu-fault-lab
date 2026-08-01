use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
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
        FeeAwareProof, LifecycleBalances, LifecycleEngine, LifecycleEvidence, LifecycleExecution,
        LifecycleInput, LifecycleKind, LifecyclePhase, LifecycleProofView,
        LifecycleRuntimeCapabilities, LifecycleWalletPort, LifecycleWalletView, NativeCdkFacade,
        NativeCdkLifecycleWallet, deterministic_exact_amount_plan,
        deterministic_fee_aware_exact_amount_plan, exact_nut07_input_state,
        garbage_collect_inactive_wallet_generations, operation_bound_recovery_mechanisms,
        supports_nut19_swap_replay, swap_recovery_report_is_complete,
    },
    lifecycle_store::{LifecycleClock, LifecycleStore},
    server::router_with_lifecycle,
};
use cdk::nuts::State;
use cdk::nuts::nut19::{CachedEndpoint, Method as Nut19Method, Path as Nut19Path};
use tower::ServiceExt;

static NEXT_DATABASE: AtomicUsize = AtomicUsize::new(0);

struct ManualClock(AtomicU64);

impl ManualClock {
    const fn new(now: u64) -> Self {
        Self(AtomicU64::new(now))
    }

    fn set(&self, now: u64) {
        self.0.store(now, Ordering::SeqCst);
    }
}

impl LifecycleClock for ManualClock {
    fn now(&self) -> Result<u64, String> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

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

struct OutboxWallet;

struct GenerationWallet {
    clock: Arc<ManualClock>,
    active: std::sync::Mutex<String>,
    previous: std::sync::Mutex<Option<String>>,
    expire_during_reset: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl LifecycleWalletPort for GenerationWallet {
    async fn reset(&self, seed: &str) -> Result<(), &'static str> {
        let mut active = self.active.lock().expect("active generation");
        *self.previous.lock().expect("previous generation") = Some(active.clone());
        *active = seed.to_owned();
        if self.expire_during_reset.load(Ordering::SeqCst) {
            let now = self.clock.0.load(Ordering::SeqCst);
            self.clock.set(now + 121);
        }
        Ok(())
    }

    async fn rollback_reset(&self) -> Result<(), &'static str> {
        if let Some(previous) = self.previous.lock().expect("previous generation").take() {
            *self.active.lock().expect("active generation") = previous;
        }
        Ok(())
    }

    async fn commit_reset(&self) -> Result<(), &'static str> {
        self.previous.lock().expect("previous generation").take();
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
}

type NativeObservation = (LifecycleKind, Option<u64>, Option<String>);

struct RecordingNativeFacade {
    observed: std::sync::Mutex<Vec<NativeObservation>>,
    fail_execute: std::sync::atomic::AtomicBool,
    recoveries: AtomicUsize,
}

#[async_trait]
impl NativeCdkFacade for RecordingNativeFacade {
    async fn reset(&self, _seed: &str) -> Result<(), String> {
        Ok(())
    }

    async fn prepare(&self, request: &LifecycleInput) -> Result<Option<Vec<u8>>, String> {
        self.observed.lock().expect("observations").push((
            request.kind,
            request.amount,
            request.recipient.clone(),
        ));
        Ok(Some(
            format!("plan:{}", request.amount.unwrap_or_default()).into_bytes(),
        ))
    }

    async fn execute(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> Result<LifecycleExecution, String> {
        assert_eq!(private_material, Some(b"plan:8".as_slice()));
        if self.fail_execute.load(Ordering::SeqCst) {
            Err("secret quote identifier and dependency detail".to_owned())
        } else {
            Ok(LifecycleExecution::succeeded(
                request.amount,
                "swap_observed",
            ))
        }
    }

    async fn recover(
        &self,
        request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> Result<LifecycleExecution, String> {
        self.recoveries.fetch_add(1, Ordering::SeqCst);
        Ok(if request.kind == LifecycleKind::Send {
            LifecycleExecution::send_succeeded(
                request.amount.expect("send amount"),
                request.recipient.as_deref().expect("recipient"),
                "cashuA-recovered-native-token",
            )
        } else {
            LifecycleExecution::succeeded(request.amount, "quote_reconciled")
        })
    }

    async fn wallet(&self) -> Result<LifecycleWalletView, String> {
        Err("unused".to_owned())
    }

    async fn capabilities(&self) -> Result<LifecycleRuntimeCapabilities, String> {
        Ok(LifecycleRuntimeCapabilities {
            operations: vec!["mint", "swap", "send", "reconcile"],
            nuts: vec![3, 4, 7],
            recovery: vec!["quote_state", "proof_state"],
        })
    }
}

#[async_trait]
impl LifecycleWalletPort for OutboxWallet {
    async fn reset(&self, _seed: &str) -> Result<(), &'static str> {
        Ok(())
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        LifecycleExecution::send_succeeded(
            request.amount.expect("send amount"),
            request.recipient.as_deref().expect("send recipient"),
            "cashuA-encrypted-token-canary",
        )
    }

    async fn recover(
        &self,
        request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        self.execute(request).await
    }
}

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
        store.reset(&"s".repeat(257), 1, 0),
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
    assert_eq!(operation.mint, "http://127.0.0.1:3338");

    let serialized = serde_json::to_value(&operation).expect("serialize operation response");
    let mint = serialized["mint"].as_str().expect("serialized mint URL");
    let parsed = url::Url::parse(mint).expect("parse serialized mint URL");
    let path = if parsed.path() == "/" {
        ""
    } else {
        parsed.path().trim_end_matches('/')
    };
    let contract_canonical = format!("{}://{}{}", parsed.scheme(), parsed.authority(), path);
    assert_eq!(mint, contract_canonical);
}

#[tokio::test]
async fn operation_identity_preserves_a_canonical_ipv6_authority() {
    let path = database_path("canonical-ipv6-mint");
    let store = Arc::new(LifecycleStore::open(path, [12_u8; 32]).expect("open lifecycle store"));
    let engine = LifecycleEngine::new(store, Arc::new(RecordingWallet::default()));
    let mut request = input("UUUUUUUUUUUUUUUUUUUUUA", LifecycleKind::Receive);
    request.mint = "http://[::1]:3338".to_owned();
    let operation = engine.start(request).await.expect("start IPv6 operation");
    assert_eq!(operation.mint, "http://[::1]:3338");
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
async fn reconcile_recovers_only_its_named_target_across_a_restart_boundary() {
    let path = database_path("target-reconcile");
    let wallet = Arc::new(RecordingWallet {
        first_ambiguous: true,
        ..Default::default()
    });
    let store = Arc::new(LifecycleStore::open(path, [13_u8; 32]).expect("open store"));
    let engine = LifecycleEngine::new(store.clone(), wallet.clone());
    let first_id = "OOOOOOOOOOOOOOOOOOOOOA";
    let second_id = "PPPPPPPPPPPPPPPPPPPPPA";
    assert_eq!(
        engine
            .start(input(first_id, LifecycleKind::Swap))
            .await
            .expect("first ambiguous target")
            .phase,
        LifecyclePhase::Ambiguous
    );
    assert_eq!(
        engine
            .start(input(second_id, LifecycleKind::Swap))
            .await
            .expect("second ambiguous target")
            .phase,
        LifecyclePhase::Ambiguous
    );
    let mut reconcile = input("QQQQQQQQQQQQQQQQQQQQQA", LifecycleKind::Reconcile);
    reconcile.target_operation_id = Some(first_id.to_owned());
    assert_eq!(
        engine
            .start(reconcile.clone())
            .await
            .expect("targeted reconcile")
            .phase,
        LifecyclePhase::Succeeded
    );
    assert_eq!(
        engine.operation(first_id).expect("first target").phase,
        LifecyclePhase::Succeeded
    );
    assert_eq!(
        engine.operation(second_id).expect("second target").phase,
        LifecyclePhase::Ambiguous
    );

    let mut persisted = engine
        .operation("QQQQQQQQQQQQQQQQQQQQQA")
        .expect("reconcile operation");
    persisted.phase = LifecyclePhase::Submitted;
    let token = store
        .try_claim(&persisted.operation_id)
        .expect("claim reconcile crash")
        .expect("reconcile fencing token");
    store
        .put(&persisted, None, token)
        .expect("persist reconcile crash boundary");
    store
        .release(&persisted.operation_id, token)
        .expect("release reconcile crash boundary");
    assert_eq!(
        engine
            .start(reconcile)
            .await
            .expect("resume reconcile after crash")
            .phase,
        LifecyclePhase::Succeeded
    );
    assert_eq!(wallet.recoveries.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn reconcile_dependency_cycle_is_rejected_without_waiting_on_claims() {
    let path = database_path("reconcile-cycle");
    let store = Arc::new(LifecycleStore::open(path, [44_u8; 32]).expect("open store"));
    let engine = LifecycleEngine::new(store.clone(), Arc::new(RecordingWallet::default()));
    let left_id = "WWWWWWWWWWWWWWWWWWWWWA";
    let right_id = "XXXXXXXXXXXXXXXXXXXXXQ";
    for (operation_id, target_operation_id) in [(left_id, right_id), (right_id, left_id)] {
        let mut request = input(operation_id, LifecycleKind::Reconcile);
        request.target_operation_id = Some(target_operation_id.to_owned());
        let operation = cashu_fault_lab_cdk_adapter::lifecycle::LifecycleOperation {
            operation_id: operation_id.to_owned(),
            kind: LifecycleKind::Reconcile,
            mint: request.mint.clone(),
            unit: request.unit.clone(),
            intent_hash: "a".repeat(64),
            phase: LifecyclePhase::Submitted,
            evidence_code: None,
            amount: None,
            input_fee: None,
            fee_reserve: None,
            actual_fee: None,
            change: None,
            request_hash: None,
            quote_hash: None,
            output_plan_hash: None,
        };
        let (_, token) = store
            .create_and_claim(&request, &operation)
            .expect("persist reconcile")
            .expect("claim reconcile");
        store.release(operation_id, token).expect("release claim");
    }

    let operation = tokio::time::timeout(Duration::from_secs(1), engine.resume(left_id))
        .await
        .expect("cycle detection must not deadlock")
        .expect("resume cyclic reconcile");
    assert_eq!(operation.phase, LifecyclePhase::FailedDefinitive);
    assert_eq!(
        operation.evidence_code.as_deref(),
        Some("reconcile_dependency_cycle")
    );
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
        let token = store
            .try_claim(&operation_id)
            .expect("claim crash phase")
            .expect("crash phase token");
        store.put(&operation, None, token).expect("set crash phase");
        store
            .release(&operation_id, token)
            .expect("release crash phase");

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
            .is_some()
    );

    let reopened = LifecycleStore::open(&path, [17_u8; 32]).expect("open second lifecycle store");
    assert!(
        reopened
            .try_claim("CCCCCCCCCCCCCCCCCCCCCA")
            .expect("competing claim")
            .is_none()
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
    let operation_token = first
        .try_claim("JJJJJJJJJJJJJJJJJJJJJA")
        .expect("claim operation")
        .expect("operation token");
    let second = LifecycleStore::open(&path, [18_u8; 32]).expect("open second lifecycle store");
    assert!(
        second
            .try_claim_reset()
            .expect("blocked reset claim")
            .is_none()
    );

    first
        .release("JJJJJJJJJJJJJJJJJJJJJA", operation_token)
        .expect("release operation");
    let reset_token = second
        .try_claim_reset()
        .expect("claim reset")
        .expect("reset token");
    assert!(
        first
            .try_claim("JJJJJJJJJJJJJJJJJJJJJA")
            .expect("blocked operation claim")
            .is_none()
    );
    second.release_reset(reset_token).expect("release reset");
}

#[tokio::test]
async fn expired_operation_owner_is_fenced_after_reacquisition() {
    let path = database_path("fencing");
    let clock = Arc::new(ManualClock::new(1_000));
    let first = Arc::new(
        LifecycleStore::open_with_clock(&path, [41_u8; 32], clock.clone())
            .expect("open first store"),
    );
    let engine = LifecycleEngine::new(first.clone(), Arc::new(RecordingWallet::default()));
    engine
        .start(input("KKKKKKKKKKKKKKKKKKKKKA", LifecycleKind::Receive))
        .await
        .expect("create operation");
    let first_token = first
        .try_claim("KKKKKKKKKKKKKKKKKKKKKA")
        .expect("claim operation")
        .expect("first fencing token");

    clock.set(1_121);
    let second = LifecycleStore::open_with_clock(&path, [41_u8; 32], clock.clone())
        .expect("open second store");
    let second_token = second
        .try_claim("KKKKKKKKKKKKKKKKKKKKKA")
        .expect("reclaim operation")
        .expect("second fencing token");
    assert!(second_token > first_token);

    let mut operation = first
        .get("KKKKKKKKKKKKKKKKKKKKKA")
        .expect("read operation")
        .expect("operation exists");
    operation.phase = LifecyclePhase::Reconciling;
    assert_eq!(
        first.put(&operation, None, first_token),
        Err("lifecycle operation claim was lost".to_owned())
    );
    assert_eq!(
        first.renew_claim("KKKKKKKKKKKKKKKKKKKKKA", first_token),
        Err("lifecycle operation claim was lost".to_owned())
    );
    assert_eq!(
        first.release("KKKKKKKKKKKKKKKKKKKKKA", first_token),
        Err("lifecycle operation claim was lost".to_owned())
    );
    let evidence = LifecycleEvidence {
        sequence: 0,
        operation_id: operation.operation_id.clone(),
        source: "adapter".to_owned(),
        event: "stale_commit".to_owned(),
        data_hash: "a".repeat(64),
    };
    assert_eq!(
        first.commit(
            &operation,
            None,
            "stale.commit",
            &evidence,
            None,
            first_token,
        ),
        Err("lifecycle operation claim was lost".to_owned())
    );
    second
        .put(&operation, None, second_token)
        .expect("active fenced owner mutates");
}

#[tokio::test]
async fn successful_send_commits_a_recipient_bound_encrypted_outbox() {
    let path = database_path("send-outbox");
    let store = Arc::new(LifecycleStore::open(&path, [42_u8; 32]).expect("open store"));
    let engine = LifecycleEngine::new(store.clone(), Arc::new(OutboxWallet));
    let operation = engine
        .start(input("LLLLLLLLLLLLLLLLLLLLLA", LifecycleKind::Send))
        .await
        .expect("execute send");
    assert_eq!(operation.phase, LifecyclePhase::Succeeded);

    let handoff = store
        .claim_send_handoff("delivery-worker")
        .expect("claim handoff")
        .expect("ready handoff");
    assert_eq!(handoff.operation_id, operation.operation_id);
    assert_eq!(handoff.recipient, "receiver");
    assert_eq!(handoff.token, "cashuA-encrypted-token-canary");
    assert!(
        store
            .claim_send_handoff("competing-worker")
            .expect("competing claim")
            .is_none()
    );
    store
        .acknowledge_send_handoff(
            &handoff.operation_id,
            &handoff.token_hash,
            "delivery-worker",
            handoff.claim_token,
        )
        .expect("ack handoff");
    assert!(
        store
            .claim_send_handoff("delivery-worker")
            .expect("post-ack claim")
            .is_none()
    );
    engine
        .start(input("TTTTTTTTTTTTTTTTTTTTTA", LifecycleKind::Send))
        .await
        .expect("second send");
    engine.reset("next-generation").await.expect("reset outbox");
    assert!(
        store
            .claim_send_handoff("delivery-worker")
            .expect("claim after reset")
            .is_none()
    );

    drop(engine);
    drop(store);
    let database = std::fs::read(path).expect("read encrypted database");
    assert!(
        !database
            .windows(b"cashuA-encrypted-token-canary".len())
            .any(|value| value == b"cashuA-encrypted-token-canary")
    );
}

#[tokio::test]
async fn expired_send_handoff_claim_is_reclaimed_with_a_new_fence() {
    let path = database_path("send-outbox-lease");
    let clock = Arc::new(ManualClock::new(10));
    let store = Arc::new(
        LifecycleStore::open_with_clock(&path, [43_u8; 32], clock.clone()).expect("open store"),
    );
    let engine = LifecycleEngine::new(store.clone(), Arc::new(OutboxWallet));
    engine
        .start(input("VVVVVVVVVVVVVVVVVVVVVA", LifecycleKind::Send))
        .await
        .expect("execute send");
    let stale = store
        .claim_send_handoff("crashed-worker")
        .expect("claim handoff")
        .expect("ready handoff");

    clock.set(131);
    let reclaimed = store
        .claim_send_handoff("replacement-worker")
        .expect("reclaim expired handoff")
        .expect("expired handoff");
    assert!(reclaimed.claim_token > stale.claim_token);
    assert_eq!(
        store.acknowledge_send_handoff(
            &stale.operation_id,
            &stale.token_hash,
            "crashed-worker",
            stale.claim_token,
        ),
        Err("lifecycle send handoff claim was lost".to_owned())
    );
    assert_eq!(
        store.release_send_handoff(&stale.operation_id, "crashed-worker", stale.claim_token,),
        Err("lifecycle send handoff claim was lost".to_owned())
    );
    store
        .acknowledge_send_handoff(
            &reclaimed.operation_id,
            &reclaimed.token_hash,
            "replacement-worker",
            reclaimed.claim_token,
        )
        .expect("fenced replacement acknowledgement");
}

#[test]
fn expired_reset_owner_cannot_clear_a_new_generation() {
    let path = database_path("reset-fencing");
    let clock = Arc::new(ManualClock::new(2_000));
    let first = LifecycleStore::open_with_clock(&path, [43_u8; 32], clock.clone())
        .expect("open first store");
    let first_token = first
        .try_claim_reset()
        .expect("claim reset")
        .expect("first reset token");
    clock.set(2_121);
    let second =
        LifecycleStore::open_with_clock(&path, [43_u8; 32], clock).expect("open second store");
    let second_token = second
        .try_claim_reset()
        .expect("reclaim reset")
        .expect("second reset token");
    assert!(second_token > first_token);
    assert_eq!(
        first.reset("stale-seed", 1, first_token),
        Err("lifecycle reset claim was lost".to_owned())
    );
    assert_eq!(
        first.renew_reset(first_token),
        Err("lifecycle reset claim was lost".to_owned())
    );
    assert_eq!(
        first.release_reset(first_token),
        Err("lifecycle reset claim was lost".to_owned())
    );
    second
        .reset("active-seed", 1, second_token)
        .expect("active reset commits generation");
    assert!(
        second
            .verify_seed("active-seed")
            .expect("verify active seed")
    );
}

#[tokio::test]
async fn journal_generation_failure_rolls_back_the_wallet_generation() {
    let path = database_path("generation-rollback");
    let clock = Arc::new(ManualClock::new(3_000));
    let store = Arc::new(
        LifecycleStore::open_with_clock(path, [47_u8; 32], clock.clone()).expect("open store"),
    );
    let wallet = Arc::new(GenerationWallet {
        clock,
        active: std::sync::Mutex::new("uninitialized".to_owned()),
        previous: std::sync::Mutex::new(None),
        expire_during_reset: std::sync::atomic::AtomicBool::new(false),
    });
    let engine = LifecycleEngine::new(store.clone(), wallet.clone());
    engine.reset("generation-a").await.expect("initial reset");
    wallet.expire_during_reset.store(true, Ordering::SeqCst);

    assert_eq!(
        engine.reset("generation-b").await,
        Err("lifecycle reset claim was lost".to_owned())
    );
    assert_eq!(
        wallet.active.lock().expect("active generation").as_str(),
        "generation-a"
    );
    assert!(
        store
            .verify_seed("generation-a")
            .expect("old journal generation")
    );
    assert!(
        !store
            .verify_seed("generation-b")
            .expect("new journal generation")
    );
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
fn native_cdk_policy_includes_adapter_bound_swap_send_and_reconcile() {
    for kind in [
        LifecycleKind::Mint,
        LifecycleKind::Swap,
        LifecycleKind::Send,
        LifecycleKind::Receive,
        LifecycleKind::Melt,
        LifecycleKind::Restore,
        LifecycleKind::Reconcile,
    ] {
        assert!(NativeCdkLifecycleWallet::operation_bound(kind));
    }
}

#[tokio::test]
async fn native_cdk_requires_initialized_durable_state_before_native_side_effects() {
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
        assert_eq!(result.evidence_code(), Some("wallet_not_initialized"));
    }
}

#[tokio::test]
async fn injected_native_facade_binds_arguments_sanitizes_errors_and_recovers_quotes() {
    let facade = Arc::new(RecordingNativeFacade {
        observed: std::sync::Mutex::new(Vec::new()),
        fail_execute: std::sync::atomic::AtomicBool::new(false),
        recoveries: AtomicUsize::new(0),
    });
    let wallet =
        NativeCdkLifecycleWallet::with_facade("http://127.0.0.1:3338", "sat", facade.clone())
            .expect("construct injected native wallet");
    let swap = input("MMMMMMMMMMMMMMMMMMMMMA", LifecycleKind::Swap);
    let mut wrong_mint = swap.clone();
    wrong_mint.mint = "http://127.0.0.1:4444".to_owned();
    assert_eq!(
        wallet
            .prepare(&wrong_mint)
            .await
            .expect_err("policy must run before injected dependency")
            .evidence_code(),
        Some("mint_or_unit_not_configured")
    );
    assert!(facade.observed.lock().expect("observations").is_empty());
    let plan = wallet
        .prepare(&swap)
        .await
        .expect("prepare native request")
        .expect("prepared plan");
    let result = wallet.execute_prepared(&swap, Some(&plan)).await;
    assert_eq!(result.amount(), Some(8));
    assert_eq!(
        facade.observed.lock().expect("observations").as_slice(),
        &[(LifecycleKind::Swap, Some(8), None)]
    );

    facade.fail_execute.store(true, Ordering::SeqCst);
    let failed = wallet.execute_prepared(&swap, Some(&plan)).await;
    assert_eq!(failed.evidence_code(), Some("native_dependency_error"));

    let mint = input("NNNNNNNNNNNNNNNNNNNNNA", LifecycleKind::Mint);
    let recovered = wallet.recover(&mint, Some(b"quote-correlation")).await;
    assert_eq!(recovered.amount(), Some(8));
    assert_eq!(recovered.evidence_code(), None);
}

#[tokio::test]
async fn native_swap_and_send_resume_the_persisted_plan_after_process_restart() {
    let path = database_path("native-crash-plans");
    let facade = Arc::new(RecordingNativeFacade {
        observed: std::sync::Mutex::new(Vec::new()),
        fail_execute: std::sync::atomic::AtomicBool::new(true),
        recoveries: AtomicUsize::new(0),
    });
    let make_wallet = || {
        Arc::new(
            NativeCdkLifecycleWallet::with_facade("http://127.0.0.1:3338", "sat", facade.clone())
                .expect("injected native wallet"),
        )
    };
    let first_store = Arc::new(LifecycleStore::open(&path, [45_u8; 32]).expect("open first store"));
    let first = LifecycleEngine::new(first_store, make_wallet());
    for (id, kind) in [
        ("RRRRRRRRRRRRRRRRRRRRRA", LifecycleKind::Swap),
        ("SSSSSSSSSSSSSSSSSSSSSA", LifecycleKind::Send),
    ] {
        assert_eq!(
            first
                .start(input(id, kind))
                .await
                .expect("submit plan")
                .phase,
            LifecyclePhase::Ambiguous
        );
    }
    drop(first);

    facade.fail_execute.store(false, Ordering::SeqCst);
    let reopened_store =
        Arc::new(LifecycleStore::open(&path, [45_u8; 32]).expect("reopen durable lifecycle store"));
    let reopened = LifecycleEngine::new(reopened_store.clone(), make_wallet());
    assert_eq!(
        reopened
            .resume("RRRRRRRRRRRRRRRRRRRRRA")
            .await
            .expect("recover swap")
            .phase,
        LifecyclePhase::Succeeded
    );
    assert_eq!(
        reopened
            .resume("SSSSSSSSSSSSSSSSSSSSSA")
            .await
            .expect("recover send")
            .phase,
        LifecyclePhase::Succeeded
    );
    let handoff = reopened_store
        .claim_send_handoff("native-delivery-worker")
        .expect("claim recovered send")
        .expect("recovered send outbox");
    assert_eq!(handoff.recipient, "receiver");
    assert_eq!(handoff.token, "cashuA-recovered-native-token");
    assert_eq!(facade.recoveries.load(Ordering::SeqCst), 2);
    assert_eq!(facade.observed.lock().expect("observations").len(), 2);
}

#[test]
fn native_cdk_never_attributes_aggregate_saga_counts_to_receive() {
    assert_eq!(
        NativeCdkLifecycleWallet::aggregate_recovery_phase(LifecycleKind::Receive),
        LifecyclePhase::RecoveryBlocked
    );
}

#[test]
fn inactive_wallet_generation_and_sidecars_are_garbage_collected_after_crash() {
    let base = database_path("generation-gc");
    let active = PathBuf::from(format!("{}.generation-2", base.display()));
    let stale_generation = PathBuf::from(format!("{}.generation-1", base.display()));
    for path in [
        base.clone(),
        PathBuf::from(format!("{}-wal", base.display())),
        PathBuf::from(format!("{}-shm", base.display())),
        stale_generation.clone(),
        PathBuf::from(format!("{}-wal", stale_generation.display())),
        PathBuf::from(format!("{}-shm", stale_generation.display())),
        active.clone(),
        PathBuf::from(format!("{}-wal", active.display())),
        PathBuf::from(format!("{}-shm", active.display())),
    ] {
        std::fs::write(path, b"generation").expect("create simulated crash artifact");
    }

    garbage_collect_inactive_wallet_generations(&base, 2).expect("collect inactive generations");

    assert!(!base.exists());
    assert!(!stale_generation.exists());
    assert!(!PathBuf::from(format!("{}-wal", stale_generation.display())).exists());
    assert!(!PathBuf::from(format!("{}-shm", stale_generation.display())).exists());
    assert!(active.exists());
    assert!(PathBuf::from(format!("{}-wal", active.display())).exists());
    assert!(PathBuf::from(format!("{}-shm", active.display())).exists());
}

#[test]
fn native_swap_plan_is_deterministic_and_exact_amount_bound() {
    let left = deterministic_exact_amount_plan(
        vec![
            ("proof-c".to_owned(), 2),
            ("proof-a".to_owned(), 4),
            ("proof-b".to_owned(), 2),
            ("proof-d".to_owned(), 1),
        ],
        6,
    )
    .expect("exact plan");
    let right = deterministic_exact_amount_plan(
        vec![
            ("proof-d".to_owned(), 1),
            ("proof-b".to_owned(), 2),
            ("proof-a".to_owned(), 4),
            ("proof-c".to_owned(), 2),
        ],
        6,
    )
    .expect("same exact plan");
    assert_eq!(left, right);
    assert_eq!(left, vec!["proof-a", "proof-b"]);
    assert_eq!(
        deterministic_exact_amount_plan(vec![("proof".to_owned(), 8)], 7),
        None
    );

    assert_eq!(
        deterministic_exact_amount_plan(
            vec![
                ("proof-4".to_owned(), 4),
                ("proof-3a".to_owned(), 3),
                ("proof-3b".to_owned(), 3),
            ],
            6,
        ),
        Some(vec!["proof-3a".to_owned(), "proof-3b".to_owned()])
    );
}

#[test]
fn native_swap_plan_accounts_for_nonzero_nut02_input_fees() {
    let plan = deterministic_fee_aware_exact_amount_plan(
        vec![
            FeeAwareProof {
                id: "proof-4".to_owned(),
                amount: 4,
                input_fee_ppk: 500,
            },
            FeeAwareProof {
                id: "proof-3".to_owned(),
                amount: 3,
                input_fee_ppk: 500,
            },
        ],
        6,
    )
    .expect("bounded search")
    .expect("fee-aware plan");

    assert_eq!(plan.proof_ids, vec!["proof-4", "proof-3"]);
    assert_eq!(plan.gross_input, 7);
    assert_eq!(plan.input_fee, 1);
    assert_eq!(plan.net_output, 6);
    assert_eq!(plan.net_output + plan.input_fee, plan.gross_input);
}

#[test]
fn native_swap_recovery_rejects_vacuous_truncated_and_mismatched_nut07() {
    let expected = vec!["y-a".to_owned(), "y-b".to_owned()];

    assert_eq!(
        exact_nut07_input_state(&expected, &[]),
        Err("swap_input_state_unbound")
    );
    assert_eq!(
        exact_nut07_input_state(&expected, &[("y-a".to_owned(), State::Spent)]),
        Err("swap_input_state_unbound")
    );
    assert_eq!(
        exact_nut07_input_state(
            &expected,
            &[
                ("y-a".to_owned(), State::Spent),
                ("y-c".to_owned(), State::Spent),
            ],
        ),
        Err("swap_input_state_unbound")
    );
    assert_eq!(
        exact_nut07_input_state(
            &expected,
            &[
                ("y-b".to_owned(), State::Spent),
                ("y-a".to_owned(), State::Spent),
            ],
        ),
        Ok(State::Spent)
    );
}

#[test]
fn native_swap_recovery_blocks_skipped_or_failed_saga_reports() {
    assert!(swap_recovery_report_is_complete(0, 0));
    assert!(!swap_recovery_report_is_complete(1, 0));
    assert!(!swap_recovery_report_is_complete(0, 1));
}

#[test]
fn proof_state_is_advertised_only_for_an_operation_bound_recovery() {
    assert_eq!(
        operation_bound_recovery_mechanisms(
            &["mint", "send", "receive", "melt", "restore", "reconcile"],
            true,
            true,
            true,
            true,
        ),
        vec!["quote_state", "nut09_restore", "nut13_seed"]
    );
    assert!(
        operation_bound_recovery_mechanisms(&["swap", "reconcile"], false, true, false, false,)
            .contains(&"proof_state")
    );
}

#[test]
fn nut19_replay_is_advertised_only_for_the_swap_endpoint() {
    assert!(!supports_nut19_swap_replay(&[CachedEndpoint::new(
        Nut19Method::Post,
        Nut19Path::Custom("/v1/melt/bolt11".to_owned()),
    )]));
    assert!(supports_nut19_swap_replay(&[CachedEndpoint::new(
        Nut19Method::Post,
        Nut19Path::Swap,
    )]));
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
    assert_eq!(
        source,
        "sha256:68815c942f4c1a309351c4485fe68e96c1571db4e0e649fbdad7fccf037a2e83"
    );
    assert_eq!(
        build,
        "sha256:5f54130000e73137784b4bed42322e42ac89d5207737febb173110fd24d91962"
    );
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
        if kind == LifecycleKind::Reconcile {
            request.target_operation_id = Some("000000000000000000000A".to_owned());
        }
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

#[tokio::test]
async fn lifecycle_http_matches_the_discriminated_shared_contract() {
    let path = database_path("http-discriminated-contract");
    let store = Arc::new(LifecycleStore::open(path, [28_u8; 32]).expect("open lifecycle store"));
    let engine = Arc::new(LifecycleEngine::new(
        store,
        Arc::new(RecordingWallet::default()),
    ));
    let app = router_with_lifecycle("control-token", None, Some(engine)).expect("build router");

    for body in [
        r#"{"operationId":"RRRRRRRRRRRRRRRRRRRRRA","kind":"receive","mint":"http://127.0.0.1:3338","unit":"sat","invoice":"lnbc-wrong-field"}"#.to_owned(),
        r#"{"operationId":"MMMMMMMMMMMMMMMMMMMMMA","kind":"melt","mint":"http://127.0.0.1:3338","unit":"sat","token":"cashu-wrong-field"}"#.to_owned(),
        r#"{"operationId":"SSSSSSSSSSSSSSSSSSSSSA","kind":"swap","mint":"http://127.0.0.1:3338/","unit":"sat","amount":8}"#.to_owned(),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/lifecycle/operations")
                    .header("authorization", "Bearer control-token")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    let reset = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/reset")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"seed":"seed","unknown":true}"#))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(reset.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let unicode_invoice = "💳".repeat(10_000);
    let body = serde_json::json!({
        "operationId": "UUUUUUUUUUUUUUUUUUUUUA",
        "kind": "melt",
        "mint": "http://127.0.0.1:3338",
        "unit": "sat",
        "invoice": unicode_invoice,
    });
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/lifecycle/operations")
                .header("authorization", "Bearer control-token")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}
