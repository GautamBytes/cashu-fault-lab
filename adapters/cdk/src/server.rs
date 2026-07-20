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
};

#[derive(Clone)]
struct AppState {
    authorization: HeaderValue,
    operations: Option<Arc<FundedCdkOperations>>,
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

pub fn router(
    control_token: &str,
    operations: Option<Arc<FundedCdkOperations>>,
) -> Result<Router, String> {
    if control_token.is_empty() {
        return Err("CASHU_FAULT_LAB_CONTROL_TOKEN cannot be empty".to_owned());
    }
    let authorization = HeaderValue::from_str(&format!("Bearer {control_token}"))
        .map_err(|_| "control token cannot be represented as an HTTP header".to_owned())?;
    let state = Arc::new(AppState {
        authorization,
        operations,
    });
    Ok(Router::<Arc<AppState>>::new()
        .route("/v1/capabilities", get(get_capabilities))
        .route("/v1/reset", post(reset))
        .route("/v1/requests", post(requests))
        .route("/v1/send", post(send))
        .route("/v1/deliveries/{id}", get(delivery))
        .route("/v1/ledger", get(ledger))
        .route("/v1/proofs", get(proofs))
        .layer(DefaultBodyLimit::max(16_384))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .with_state(state))
}
