use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State, rejection::JsonRejection},
    http::{HeaderValue, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bitcoin::hashes::{Hash, sha256};
use serde::{Deserialize, Serialize};

use crate::{
    AdapterCapabilities, capabilities,
    funded::{FundedCdkOperations, SendInput},
    funded_capabilities,
    lifecycle::{
        LifecycleEngine, LifecycleEvidence, LifecycleInput, LifecycleKind, LifecycleOperation,
        LifecycleWalletView,
    },
};

// 262,144 Unicode scalar values can require 12 JSON bytes each when encoded as a surrogate pair,
// plus the bounded lifecycle request envelope.
const LIFECYCLE_OPERATION_BODY_LIMIT: usize = 3_200_000;
const JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone)]
struct AppState {
    authorization: HeaderValue,
    operations: Option<Arc<FundedCdkOperations>>,
    lifecycle: Option<Arc<LifecycleEngine>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetInput {
    seed: String,
}

#[derive(Serialize)]
struct ResetOutput {
    ok: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum LifecycleStartInput {
    Mint {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
        amount: u64,
        method: String,
    },
    Swap {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
        amount: u64,
    },
    Send {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
        amount: u64,
        recipient: String,
    },
    Receive {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
        token: String,
    },
    Melt {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
        invoice: String,
        #[serde(rename = "preferAsync")]
        prefer_async: Option<bool>,
    },
    Restore {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
    },
    Reconcile {
        #[serde(rename = "operationId")]
        operation_id: String,
        mint: String,
        unit: String,
        #[serde(rename = "targetOperationId")]
        target_operation_id: String,
    },
}

impl From<LifecycleStartInput> for LifecycleInput {
    fn from(input: LifecycleStartInput) -> Self {
        let (
            operation_id,
            kind,
            mint,
            unit,
            amount,
            method,
            recipient,
            secret,
            prefer_async,
            target_operation_id,
        ) = match input {
            LifecycleStartInput::Mint {
                operation_id,
                mint,
                unit,
                amount,
                method,
            } => (
                operation_id,
                LifecycleKind::Mint,
                mint,
                unit,
                Some(amount),
                Some(method),
                None,
                None,
                None,
                None,
            ),
            LifecycleStartInput::Swap {
                operation_id,
                mint,
                unit,
                amount,
            } => (
                operation_id,
                LifecycleKind::Swap,
                mint,
                unit,
                Some(amount),
                None,
                None,
                None,
                None,
                None,
            ),
            LifecycleStartInput::Send {
                operation_id,
                mint,
                unit,
                amount,
                recipient,
            } => (
                operation_id,
                LifecycleKind::Send,
                mint,
                unit,
                Some(amount),
                None,
                Some(recipient),
                None,
                None,
                None,
            ),
            LifecycleStartInput::Receive {
                operation_id,
                mint,
                unit,
                token,
            } => (
                operation_id,
                LifecycleKind::Receive,
                mint,
                unit,
                None,
                None,
                None,
                Some(token),
                None,
                None,
            ),
            LifecycleStartInput::Melt {
                operation_id,
                mint,
                unit,
                invoice,
                prefer_async,
            } => (
                operation_id,
                LifecycleKind::Melt,
                mint,
                unit,
                None,
                None,
                None,
                Some(invoice),
                prefer_async,
                None,
            ),
            LifecycleStartInput::Restore {
                operation_id,
                mint,
                unit,
            } => (
                operation_id,
                LifecycleKind::Restore,
                mint,
                unit,
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            LifecycleStartInput::Reconcile {
                operation_id,
                mint,
                unit,
                target_operation_id,
            } => (
                operation_id,
                LifecycleKind::Reconcile,
                mint,
                unit,
                None,
                None,
                None,
                None,
                None,
                Some(target_operation_id),
            ),
        };
        Self {
            operation_id,
            kind,
            mint,
            unit,
            amount,
            method,
            recipient,
            secret,
            prefer_async,
            target_operation_id,
        }
    }
}

#[derive(Serialize)]
struct NotApplicable {
    status: &'static str,
    reason: &'static str,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

fn secure_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

async fn authenticate(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let supplied = request
        .headers()
        .get(AUTHORIZATION)
        .map(HeaderValue::as_bytes)
        .unwrap_or_default();
    if !secure_equal(supplied, state.authorization.as_bytes()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                code: "UNAUTHORIZED",
                message: "A valid adapter control token is required".to_owned(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

async fn get_capabilities(State(state): State<Arc<AppState>>) -> Json<AdapterCapabilities> {
    Json(if state.operations.is_some() {
        funded_capabilities()
    } else {
        capabilities()
    })
}

async fn reset(State(state): State<Arc<AppState>>, Json(input): Json<ResetInput>) -> Response {
    if input.seed.is_empty() {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_SEED",
            "Seed is required",
        );
    }
    if let Some(operations) = &state.operations
        && let Err(message) = operations.reset(&input.seed).await
    {
        return error(StatusCode::BAD_GATEWAY, "WALLET_RESET_FAILED", message);
    }
    (StatusCode::OK, Json(ResetOutput { ok: true })).into_response()
}

async fn send(State(state): State<Arc<AppState>>, Json(input): Json<SendInput>) -> Response {
    let Some(operations) = &state.operations else {
        return not_applicable("No funded CDK wallet operations were configured");
    };
    match operations.send(input).await {
        Ok(receipt) => (StatusCode::OK, Json(receipt)).into_response(),
        Err(message) => error(StatusCode::UNPROCESSABLE_ENTITY, "SEND_FAILED", message),
    }
}

async fn delivery(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(operations) = &state.operations else {
        return not_applicable("Delivery state operations are not configured");
    };
    match operations.delivery(&id).await {
        Ok(receipt) => (StatusCode::OK, Json(receipt)).into_response(),
        Err(message) => error(StatusCode::NOT_FOUND, "DELIVERY_NOT_FOUND", message),
    }
}

async fn proofs(State(state): State<Arc<AppState>>) -> Response {
    let Some(operations) = &state.operations else {
        return not_applicable("Proof evidence operations are not configured");
    };
    match operations.proofs().await {
        Ok(evidence) => (StatusCode::OK, Json(evidence)).into_response(),
        Err(message) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "PROOF_EVIDENCE_FAILED",
            message,
        ),
    }
}

async fn ledger() -> Response {
    not_applicable("Sender-only CDK adapter has no merchant ledger")
}

async fn requests() -> Response {
    not_applicable("CDK funded adapter is sender-only")
}

fn not_applicable(reason: &'static str) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(NotApplicable {
            status: "N/A",
            reason,
        }),
    )
        .into_response()
}

fn error(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    (
        status,
        Json(ErrorBody {
            code,
            message: message.into(),
        }),
    )
        .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleImplementation {
    id: &'static str,
    version: &'static str,
    language: &'static str,
    runtime: &'static str,
    source_digest: String,
    build_digest: String,
}

#[derive(Serialize)]
struct LifecycleMint {
    id: &'static str,
    implementation: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleCapabilities {
    schema_version: u32,
    implementation: LifecycleImplementation,
    operations: Vec<&'static str>,
    nuts: Vec<u16>,
    durability: &'static str,
    recovery: Vec<&'static str>,
    mints: [LifecycleMint; 1],
}

async fn lifecycle_capabilities(State(state): State<Arc<AppState>>) -> Response {
    let Some(engine) = state.lifecycle.as_ref() else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    let runtime = match engine.capabilities().await {
        Ok(runtime) => runtime,
        Err(message) => return lifecycle_error(&message),
    };
    Json(LifecycleCapabilities {
        schema_version: cashu_fault_lab_wallet_lifecycle_contract::SCHEMA_VERSION,
        implementation: LifecycleImplementation {
            id: "cdk",
            version: env!("CARGO_PKG_VERSION"),
            language: "rust",
            runtime: "cdk-0.17.3",
            source_digest: lifecycle_identity_digest("source"),
            build_digest: lifecycle_identity_digest("build"),
        },
        operations: runtime.operations,
        nuts: runtime.nuts,
        durability: "restart_safe",
        recovery: runtime.recovery,
        mints: [LifecycleMint {
            id: "configured-mint",
            implementation: "configured",
        }],
    })
    .into_response()
}

fn lifecycle_identity_digest(domain: &str) -> String {
    let identity = format!("cdk\0{}\0rust\0cdk-0.17.3", env!("CARGO_PKG_VERSION"));
    let material = format!("cashu-fault-lab/{domain}/v1\0{identity}");
    format!("sha256:{}", sha256::Hash::hash(material.as_bytes()))
}

fn lifecycle_engine(state: &AppState) -> Option<&Arc<LifecycleEngine>> {
    state.lifecycle.as_ref()
}

fn lifecycle_error(message: &str) -> Response {
    if message == "lifecycle operation is not applicable" {
        not_applicable("The requested lifecycle operation is not safely supported")
    } else if message.contains("not found") {
        error(
            StatusCode::NOT_FOUND,
            "LIFECYCLE_OPERATION_NOT_FOUND",
            "Lifecycle operation was not found",
        )
    } else if message.contains("conflict") {
        error(
            StatusCode::CONFLICT,
            "LIFECYCLE_OPERATION_ID_CONFLICT",
            "Lifecycle operation identity conflicts",
        )
    } else if message.contains("invalid") || message.contains("required") {
        error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LIFECYCLE_SCHEMA_INVALID",
            "Lifecycle request is invalid",
        )
    } else {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LIFECYCLE_INTERNAL",
            "Lifecycle operation failed",
        )
    }
}

fn lifecycle_number_bound_error() -> Response {
    error(
        StatusCode::INSUFFICIENT_STORAGE,
        "LIFECYCLE_RESPONSE_TOO_LARGE",
        "Lifecycle response contains a number above the JavaScript safe-integer bound",
    )
}

fn operation_numbers_are_safe(operation: &LifecycleOperation) -> bool {
    [
        operation.amount,
        operation.input_fee,
        operation.fee_reserve,
        operation.actual_fee,
        operation.change,
    ]
    .into_iter()
    .flatten()
    .all(|value| value <= JAVASCRIPT_SAFE_INTEGER)
}

fn wallet_numbers_are_safe(wallet: &LifecycleWalletView) -> bool {
    wallet.balances.available <= JAVASCRIPT_SAFE_INTEGER
        && wallet.balances.reserved <= JAVASCRIPT_SAFE_INTEGER
        && wallet.balances.recoverable <= JAVASCRIPT_SAFE_INTEGER
}

fn evidence_numbers_are_safe(evidence: &[LifecycleEvidence]) -> bool {
    evidence
        .iter()
        .all(|item| item.sequence <= JAVASCRIPT_SAFE_INTEGER)
}

async fn lifecycle_reset(
    State(state): State<Arc<AppState>>,
    input: Result<Json<ResetInput>, JsonRejection>,
) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    let Json(input) = match input {
        Ok(input) => input,
        Err(_) => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "LIFECYCLE_SCHEMA_INVALID",
                "Lifecycle request is invalid",
            );
        }
    };
    match engine.reset(&input.seed).await {
        Ok(()) => (StatusCode::OK, Json(ResetOutput { ok: true })).into_response(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_start(
    State(state): State<Arc<AppState>>,
    input: Result<Json<LifecycleStartInput>, JsonRejection>,
) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    let Json(input) = match input {
        Ok(input) => input,
        Err(_) => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "LIFECYCLE_SCHEMA_INVALID",
                "Lifecycle request is invalid",
            );
        }
    };
    match engine.start(input.into()).await {
        Ok(operation) if operation_numbers_are_safe(&operation) => {
            (StatusCode::OK, Json(operation)).into_response()
        }
        Ok(_) => lifecycle_number_bound_error(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_resume(
    State(state): State<Arc<AppState>>,
    Path(operation_id): Path<String>,
) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.resume(&operation_id).await {
        Ok(operation) if operation_numbers_are_safe(&operation) => {
            (StatusCode::OK, Json(operation)).into_response()
        }
        Ok(_) => lifecycle_number_bound_error(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_operation(
    State(state): State<Arc<AppState>>,
    Path(operation_id): Path<String>,
) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.operation(&operation_id) {
        Ok(operation) if operation_numbers_are_safe(&operation) => {
            (StatusCode::OK, Json(operation)).into_response()
        }
        Ok(_) => lifecycle_number_bound_error(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_wallet(State(state): State<Arc<AppState>>) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.wallet().await {
        Ok(wallet) if wallet.proofs.len() <= 10_000 && wallet_numbers_are_safe(&wallet) => {
            (StatusCode::OK, Json(wallet)).into_response()
        }
        Ok(_) => error(
            StatusCode::INSUFFICIENT_STORAGE,
            "LIFECYCLE_RESPONSE_TOO_LARGE",
            "Lifecycle wallet response exceeds its bound",
        ),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_evidence(State(state): State<Arc<AppState>>) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.evidence() {
        Ok(evidence) if evidence.len() <= 100_000 && evidence_numbers_are_safe(&evidence) => {
            (StatusCode::OK, Json(evidence)).into_response()
        }
        Ok(_) => error(
            StatusCode::INSUFFICIENT_STORAGE,
            "LIFECYCLE_RESPONSE_TOO_LARGE",
            "Lifecycle evidence response exceeds its bound",
        ),
        Err(message) => lifecycle_error(&message),
    }
}

pub fn router(
    control_token: &str,
    operations: Option<Arc<FundedCdkOperations>>,
) -> Result<Router, String> {
    router_with_lifecycle(control_token, operations, None)
}

pub fn router_with_lifecycle(
    control_token: &str,
    operations: Option<Arc<FundedCdkOperations>>,
    lifecycle: Option<Arc<LifecycleEngine>>,
) -> Result<Router, String> {
    if control_token.is_empty() {
        return Err("CASHU_FAULT_LAB_CONTROL_TOKEN cannot be empty".to_owned());
    }
    let authorization = HeaderValue::from_str(&format!("Bearer {control_token}"))
        .map_err(|_| "control token cannot be represented as an HTTP header".to_owned())?;
    let state = Arc::new(AppState {
        authorization,
        operations,
        lifecycle,
    });
    Ok(Router::<Arc<AppState>>::new()
        .route("/v1/capabilities", get(get_capabilities))
        .route("/v1/reset", post(reset))
        .route("/v1/requests", post(requests))
        .route("/v1/send", post(send))
        .route("/v1/deliveries/{id}", get(delivery))
        .route("/v1/ledger", get(ledger))
        .route("/v1/proofs", get(proofs))
        .route("/v1/lifecycle/capabilities", get(lifecycle_capabilities))
        .route("/v1/lifecycle/reset", post(lifecycle_reset))
        .route(
            "/v1/lifecycle/operations",
            post(lifecycle_start).layer(DefaultBodyLimit::max(LIFECYCLE_OPERATION_BODY_LIMIT)),
        )
        .route(
            "/v1/lifecycle/operations/{id}/resume",
            post(lifecycle_resume),
        )
        .route("/v1/lifecycle/operations/{id}", get(lifecycle_operation))
        .route("/v1/lifecycle/wallet", get(lifecycle_wallet))
        .route("/v1/lifecycle/evidence", get(lifecycle_evidence))
        .layer(DefaultBodyLimit::max(16_384))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .with_state(state))
}
