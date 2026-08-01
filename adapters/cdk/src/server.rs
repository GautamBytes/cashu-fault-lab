use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderValue, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    AdapterCapabilities, capabilities,
    funded::{FundedCdkOperations, SendInput},
    funded_capabilities,
    lifecycle::{LifecycleEngine, LifecycleInput},
};

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
    source_digest: &'static str,
    build_digest: &'static str,
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
            source_digest: cashu_fault_lab_wallet_lifecycle_contract::SPEC_DIGEST,
            build_digest: cashu_fault_lab_wallet_lifecycle_contract::SPEC_DIGEST,
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

fn lifecycle_engine(state: &AppState) -> Option<&Arc<LifecycleEngine>> {
    state.lifecycle.as_ref()
}

fn lifecycle_error(message: &str) -> Response {
    if message.contains("not found") {
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

async fn lifecycle_reset(
    State(state): State<Arc<AppState>>,
    Json(input): Json<ResetInput>,
) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.reset(&input.seed).await {
        Ok(()) => (StatusCode::OK, Json(ResetOutput { ok: true })).into_response(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_start(
    State(state): State<Arc<AppState>>,
    Json(input): Json<LifecycleInput>,
) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.start(input).await {
        Ok(operation) => (StatusCode::OK, Json(operation)).into_response(),
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
        Ok(operation) => (StatusCode::OK, Json(operation)).into_response(),
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
        Ok(operation) => (StatusCode::OK, Json(operation)).into_response(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_wallet(State(state): State<Arc<AppState>>) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.wallet().await {
        Ok(wallet) => (StatusCode::OK, Json(wallet)).into_response(),
        Err(message) => lifecycle_error(&message),
    }
}

async fn lifecycle_evidence(State(state): State<Arc<AppState>>) -> Response {
    let Some(engine) = lifecycle_engine(&state) else {
        return not_applicable("Durable CDK lifecycle operations are not configured");
    };
    match engine.evidence() {
        Ok(evidence) if evidence.len() <= 100_000 => {
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
        .route("/v1/lifecycle/operations", post(lifecycle_start))
        .route(
            "/v1/lifecycle/operations/{id}/resume",
            post(lifecycle_resume),
        )
        .route("/v1/lifecycle/operations/{id}", get(lifecycle_operation))
        .route("/v1/lifecycle/wallet", get(lifecycle_wallet))
        .route("/v1/lifecycle/evidence", get(lifecycle_evidence))
        .layer(DefaultBodyLimit::max(300_000))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .with_state(state))
}
