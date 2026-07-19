use std::{env, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cashu_fault_lab_cdk_adapter::capabilities;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
struct AppState {
    authorization: HeaderValue,
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
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(request).await
}

async fn get_capabilities() -> Json<cashu_fault_lab_cdk_adapter::AdapterCapabilities> {
    Json(capabilities())
}

async fn reset(Json(input): Json<ResetInput>) -> impl IntoResponse {
    if input.seed.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ResetOutput { ok: false }),
        );
    }
    (StatusCode::OK, Json(ResetOutput { ok: true }))
}

async fn not_applicable() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(NotApplicable {
            status: "N/A",
            reason: "No funded CDK wallet/receiver operations were configured",
        }),
    )
}

async fn delivery(Path(_id): Path<String>) -> impl IntoResponse {
    not_applicable().await
}

fn router(control_token: &str) -> Result<Router, String> {
    if control_token.is_empty() {
        return Err("CASHU_FAULT_LAB_CONTROL_TOKEN cannot be empty".to_owned());
    }
    let authorization = HeaderValue::from_str(&format!("Bearer {control_token}"))
        .map_err(|_| "control token cannot be represented as an HTTP header".to_owned())?;
    let state = Arc::new(AppState { authorization });
    Ok(Router::<Arc<AppState>>::new()
        .route("/v1/capabilities", get(get_capabilities))
        .route("/v1/reset", post(reset))
        .route("/v1/requests", post(not_applicable))
        .route("/v1/send", post(not_applicable))
        .route("/v1/deliveries/{id}", get(delivery))
        .route("/v1/ledger", get(not_applicable))
        .route("/v1/proofs", get(not_applicable))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .with_state(state))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let control_token = env::var("CASHU_FAULT_LAB_CONTROL_TOKEN")
        .map_err(|_| "CASHU_FAULT_LAB_CONTROL_TOKEN is required")?;
    let address =
        env::var("CASHU_FAULT_LAB_CDK_LISTEN").unwrap_or_else(|_| "127.0.0.1:8088".to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    axum::serve(listener, router(&control_token)?.into_make_service()).await?;
    Ok(())
}
