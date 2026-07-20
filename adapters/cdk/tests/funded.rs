use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use cashu_fault_lab_cdk_adapter::funded::{
    DeliveryReceipt, FundedCdkOperations, ReservedProofs, SendInput, TransportPort, WalletPort,
};
use cdk::nuts::{CurrencyUnit, PaymentRequest, Transport, TransportType};
use serde_json::json;
use tower::ServiceExt;

const NOW: u64 = 1_784_399_400;
const REQUEST_ID: &str = "AAECAwQFBgcICQoLDA0ODw";
const DELIVERY_ID: &str = "EBESExQVFhcYGRobHB0eHw";

fn request(amount: u64) -> String {
    PaymentRequest::builder()
        .payment_id(REQUEST_ID)
        .amount(amount)
        .unit(CurrencyUnit::Sat)
        .single_use(true)
        .add_mint("https://mint.example".parse().unwrap())
        .add_transport(Transport {
            _type: TransportType::HttpPost,
            target: "http://127.0.0.1:8181/pay".to_owned(),
            tags: vec![],
        })
        .build()
        .to_string()
}

struct FakeWallet {
    reserves: AtomicUsize,
    settled: AtomicUsize,
}

#[async_trait]
impl WalletPort for FakeWallet {
    async fn reset(&self, _seed: &str) -> Result<(), String> {
        self.reserves.store(0, Ordering::SeqCst);
        self.settled.store(0, Ordering::SeqCst);
        Ok(())
    }

    async fn reserve(
        &self,
        _amount: u64,
        _unit: &str,
        _mints: &[String],
        _delivery_id: &str,
    ) -> Result<ReservedProofs, String> {
        self.reserves.fetch_add(1, Ordering::SeqCst);
        Ok(ReservedProofs {
            mint: "https://mint.example".to_owned(),
            proofs: vec![json!({
                "amount": 9,
                "id": "00aa",
                "secret": "funded-proof-secret",
                "C": format!("02{}", "11".repeat(32)),
            })],
            input_ys: vec![format!("02{}", "01".repeat(32))],
            proof_set_hash: "b".repeat(64),
        })
    }

    async fn mark_settled(&self, _delivery_id: &str) -> Result<(), String> {
        self.settled.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct FakeTransport {
    bodies: tokio::sync::Mutex<Vec<Vec<u8>>>,
    lose_first: bool,
}

#[async_trait]
impl TransportPort for FakeTransport {
    async fn post(&self, _target: &str, body: &[u8]) -> Result<DeliveryReceipt, String> {
        let payload: serde_json::Value = serde_json::from_slice(body).unwrap();
        let mut bodies = self.bodies.lock().await;
        bodies.push(body.to_vec());
        if self.lose_first && bodies.len() == 1 {
            return Err("accepted but response lost".to_owned());
        }
        Ok(DeliveryReceipt {
            profile: "cashu-delivery-v1".to_owned(),
            request_id: payload["id"].as_str().unwrap().to_owned(),
            delivery_id: payload["delivery"]["id"].as_str().unwrap().to_owned(),
            payload_hash: cashu_fault_lab_cdk_adapter::funded::payload_hash_from_json(&payload)
                .unwrap(),
            status: "settled".to_owned(),
            status_version: 2,
            mint: payload["mint"].as_str().unwrap().to_owned(),
            unit: payload["unit"].as_str().unwrap().to_owned(),
            amount: 8,
            detail_code: "settled".to_owned(),
        })
    }
}

fn fixture(lose_first: bool) -> (Arc<FakeWallet>, Arc<FakeTransport>, FundedCdkOperations) {
    let wallet = Arc::new(FakeWallet {
        reserves: AtomicUsize::new(0),
        settled: AtomicUsize::new(0),
    });
    let transport = Arc::new(FakeTransport {
        bodies: tokio::sync::Mutex::new(vec![]),
        lose_first,
    });
    let operations = FundedCdkOperations::new(wallet.clone(), transport.clone(), || NOW);
    (wallet, transport, operations)
}

#[tokio::test]
async fn reserves_once_and_retransmits_exact_bytes() {
    let (wallet, transport, operations) = fixture(false);
    operations.reset("funded-seed").await.unwrap();

    let input = SendInput {
        request: request(8),
        delivery_id: Some(DELIVERY_ID.to_owned()),
        memo: None,
    };
    let first = operations.send(input.clone()).await.unwrap();
    let second = operations.send(input).await.unwrap();

    assert_eq!(first, second);
    assert_eq!(wallet.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(wallet.settled.load(Ordering::SeqCst), 1);
    let bodies = transport.bodies.lock().await;
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    drop(bodies);
    assert_eq!(operations.delivery(DELIVERY_ID).await.unwrap(), first);
    let evidence = operations.proofs().await.unwrap();
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].state, "spent");
    assert!(
        !serde_json::to_string(&evidence)
            .unwrap()
            .contains("funded-proof-secret")
    );
}

#[tokio::test]
async fn recovers_lost_response_without_re_reserving() {
    let (wallet, transport, operations) = fixture(true);
    operations.reset("response-loss").await.unwrap();
    let input = SendInput {
        request: request(8),
        delivery_id: Some(DELIVERY_ID.to_owned()),
        memo: None,
    };

    assert!(operations.send(input.clone()).await.is_err());
    assert_eq!(operations.send(input).await.unwrap().status, "settled");
    assert_eq!(wallet.reserves.load(Ordering::SeqCst), 1);
    let bodies = transport.bodies.lock().await;
    assert_eq!(bodies[0], bodies[1]);
}

#[tokio::test]
async fn rejects_delivery_id_rebinding() {
    let (wallet, _transport, operations) = fixture(false);
    operations.reset("conflict").await.unwrap();
    operations
        .send(SendInput {
            request: request(8),
            delivery_id: Some(DELIVERY_ID.to_owned()),
            memo: None,
        })
        .await
        .unwrap();

    let error = operations
        .send(SendInput {
            request: request(9),
            delivery_id: Some(DELIVERY_ID.to_owned()),
            memo: None,
        })
        .await
        .unwrap_err();
    assert!(error.contains("already bound"));
    assert_eq!(wallet.reserves.load(Ordering::SeqCst), 1);
}

#[test]
fn matches_published_payload_fingerprint_vector() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/delivery-v1-fingerprints.json"
    ))
    .unwrap();
    let input = &vectors["payload"]["input"];
    assert_eq!(
        cashu_fault_lab_cdk_adapter::funded::payload_hash(
            input["request_id"].as_str().unwrap(),
            input["memo"].as_str(),
            input["mint"].as_str().unwrap(),
            input["unit"].as_str().unwrap(),
            input["proofs"].as_array().unwrap(),
            input["created_at"].as_u64().unwrap(),
            input["expires_at"].as_u64().unwrap(),
        )
        .unwrap(),
        vectors["payload"]["sha256"].as_str().unwrap()
    );
}

#[test]
fn matches_published_proof_set_fingerprint_vector() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/delivery-v1-fingerprints.json"
    ))
    .unwrap();
    let input = &vectors["proof_set"]["input"];
    let ys = input["ys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        cashu_fault_lab_cdk_adapter::funded::proof_set_hash(
            input["mint"].as_str().unwrap(),
            input["unit"].as_str().unwrap(),
            &ys,
        )
        .unwrap(),
        vectors["proof_set"]["sha256"].as_str().unwrap()
    );
}

#[tokio::test]
async fn exposes_funded_sender_over_authenticated_http_contract() {
    let (_wallet, _transport, operations) = fixture(false);
    let app =
        cashu_fault_lab_cdk_adapter::server::router("control-token", Some(Arc::new(operations)))
            .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/capabilities")
                .header("authorization", "Bearer control-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 16_384).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["evidenceTier"], "T1");
    assert!(value["profiles"].as_array().unwrap().iter().any(|profile| {
        profile["name"] == "delivery-v1"
            && profile["roles"] == json!(["sender"])
            && profile["status"] == "supported"
    }));
}
