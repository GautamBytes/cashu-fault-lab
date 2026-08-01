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
use cashu_fault_lab_cdk_adapter::{
    lifecycle::{
        LifecycleEngine, LifecycleExecution, LifecycleInput, LifecycleKind, LifecyclePhase,
        LifecycleWalletPort,
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
async fn all_native_lifecycle_operations_emit_sanitized_observations() {
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
