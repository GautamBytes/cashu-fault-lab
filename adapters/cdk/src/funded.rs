use std::{collections::HashMap, str::FromStr, sync::Arc};

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bitcoin::hashes::{Hash, sha256};
use cdk::nuts::{PaymentRequest, TransportType};
use ciborium::value::{CanonicalValue, Value as CborValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::sync::Mutex;
use url::Url;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PAYLOAD_BYTES: usize = 65_536;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendInput {
    pub request: String,
    pub delivery_id: Option<String>,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryReceipt {
    pub profile: String,
    pub request_id: String,
    pub delivery_id: String,
    pub payload_hash: String,
    pub status: String,
    pub status_version: u64,
    pub mint: String,
    pub unit: String,
    pub amount: u64,
    pub detail_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofEvidence {
    pub delivery_id: String,
    pub proof_set_hash: String,
    pub input_ys: Vec<String>,
    pub state: String,
}

#[derive(Debug, Clone)]
pub struct ReservedProofs {
    pub mint: String,
    pub proofs: Vec<JsonValue>,
    pub input_ys: Vec<String>,
    pub proof_set_hash: String,
}

#[async_trait]
pub trait WalletPort: Send + Sync {
    async fn reset(&self, seed: &str) -> Result<(), String>;
    async fn reserve(
        &self,
        amount: u64,
        unit: &str,
        mints: &[String],
        delivery_id: &str,
    ) -> Result<ReservedProofs, String>;
    async fn mark_settled(&self, delivery_id: &str) -> Result<(), String>;
}

#[async_trait]
pub trait TransportPort: Send + Sync {
    async fn post(&self, target: &str, body: &[u8]) -> Result<DeliveryReceipt, String>;
}

#[derive(Clone)]
struct ParsedRequest {
    id: String,
    amount: u64,
    unit: String,
    mints: Vec<String>,
    target: String,
}

#[derive(Clone)]
struct StoredDelivery {
    request_id: String,
    request_fingerprint: String,
    target: String,
    payload_bytes: Vec<u8>,
    payload_hash: String,
    mint: String,
    unit: String,
    amount: u64,
    input_ys: Vec<String>,
    proof_set_hash: String,
    receipt: Option<DeliveryReceipt>,
    settled_marked: bool,
}

#[derive(Default)]
struct State {
    seed: Option<String>,
    ordinal: u64,
    records: HashMap<String, StoredDelivery>,
}

pub struct FundedCdkOperations {
    wallet: Arc<dyn WalletPort>,
    transport: Arc<dyn TransportPort>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<State>,
    send_lock: Mutex<()>,
}

impl FundedCdkOperations {
    pub fn new<W, T, N>(wallet: Arc<W>, transport: Arc<T>, now: N) -> Self
    where
        W: WalletPort + 'static,
        T: TransportPort + 'static,
        N: Fn() -> u64 + Send + Sync + 'static,
    {
        Self {
            wallet,
            transport,
            now: Arc::new(now),
            state: Mutex::new(State::default()),
            send_lock: Mutex::new(()),
        }
    }

    pub async fn reset(&self, seed: &str) -> Result<(), String> {
        if seed.is_empty() {
            return Err("CDK funded adapter seed is required".to_owned());
        }
        let _send = self.send_lock.lock().await;
        self.wallet.reset(seed).await?;
        *self.state.lock().await = State {
            seed: Some(seed.to_owned()),
            ..State::default()
        };
        Ok(())
    }

    pub async fn send(&self, input: SendInput) -> Result<DeliveryReceipt, String> {
        let _send = self.send_lock.lock().await;
        let request = parse_request(&input.request)?;
        let request_fingerprint = hash_bytes(
            &serde_json::to_vec(&json!([input.request, input.memo])).map_err(stable_error)?,
        );

        let delivery_id = {
            let mut state = self.state.lock().await;
            let seed = state
                .seed
                .as_ref()
                .ok_or_else(|| "CDK funded adapter must be reset first".to_owned())?;
            match input.delivery_id.as_deref() {
                Some(value) => {
                    validate_protocol_id(value)?;
                    value.to_owned()
                }
                None => {
                    let value = protocol_id(seed, &request.id, state.ordinal);
                    state.ordinal += 1;
                    value
                }
            }
        };

        let existing = self.state.lock().await.records.get(&delivery_id).cloned();
        let record = match existing {
            Some(record) => {
                if record.request_fingerprint != request_fingerprint {
                    return Err(
                        "Delivery ID is already bound to another payment request".to_owned()
                    );
                }
                record
            }
            None => {
                let now = (self.now)();
                if now > MAX_SAFE_INTEGER || now.checked_add(900).is_none() {
                    return Err("CDK adapter time is invalid".to_owned());
                }
                let reserved = self
                    .wallet
                    .reserve(request.amount, &request.unit, &request.mints, &delivery_id)
                    .await?;
                let mint = normalize_mint_url(&reserved.mint)?;
                if !request.mints.contains(&mint) {
                    return Err("CDK wallet reserved proofs from an unrequested mint".to_owned());
                }
                validate_reserved(&reserved, request.amount)?;
                let payload = json!({
                    "id": request.id,
                    "memo": input.memo,
                    "mint": mint,
                    "unit": request.unit,
                    "proofs": reserved.proofs,
                    "delivery": {
                        "v": 1,
                        "id": delivery_id,
                        "created_at": now,
                        "expires_at": now + 900,
                    },
                });
                let payload_bytes = serde_json::to_vec(&payload).map_err(stable_error)?;
                if payload_bytes.len() > MAX_PAYLOAD_BYTES {
                    return Err("Cashu payment payload is too large".to_owned());
                }
                let payload_hash = payload_hash_from_json(&payload)?;
                let record = StoredDelivery {
                    request_id: request.id,
                    request_fingerprint,
                    target: request.target,
                    payload_bytes,
                    payload_hash,
                    mint,
                    unit: request.unit,
                    amount: request.amount,
                    input_ys: reserved.input_ys,
                    proof_set_hash: reserved.proof_set_hash,
                    receipt: None,
                    settled_marked: false,
                };
                // Store the proof-bearing exact bytes before the first network attempt.
                self.state
                    .lock()
                    .await
                    .records
                    .insert(delivery_id.clone(), record.clone());
                record
            }
        };

        let receipt = self
            .transport
            .post(&record.target, &record.payload_bytes)
            .await
            .map_err(|_| "Cashu payment delivery failed".to_owned())?;
        validate_receipt(&receipt, &record, &delivery_id)?;

        let mark_settled = receipt.status == "settled" && !record.settled_marked;
        if mark_settled {
            self.wallet.mark_settled(&delivery_id).await?;
        }
        let mut state = self.state.lock().await;
        let stored = state
            .records
            .get_mut(&delivery_id)
            .ok_or_else(|| "CDK delivery state was lost".to_owned())?;
        stored.receipt = Some(receipt.clone());
        stored.settled_marked |= mark_settled;
        Ok(receipt)
    }

    pub async fn delivery(&self, delivery_id: &str) -> Result<DeliveryReceipt, String> {
        validate_protocol_id(delivery_id)?;
        self.state
            .lock()
            .await
            .records
            .get(delivery_id)
            .and_then(|record| record.receipt.clone())
            .ok_or_else(|| "No delivery receipt has been observed".to_owned())
    }

    pub async fn proofs(&self) -> Result<Vec<ProofEvidence>, String> {
        let state = self.state.lock().await;
        let mut evidence = state
            .records
            .iter()
            .map(|(delivery_id, record)| ProofEvidence {
                delivery_id: delivery_id.clone(),
                proof_set_hash: record.proof_set_hash.clone(),
                input_ys: record.input_ys.clone(),
                state: if record.settled_marked {
                    "spent"
                } else {
                    "pending"
                }
                .to_owned(),
            })
            .collect::<Vec<_>>();
        evidence.sort_by(|left, right| left.delivery_id.cmp(&right.delivery_id));
        Ok(evidence)
    }
}

fn parse_request(encoded: &str) -> Result<ParsedRequest, String> {
    let request = PaymentRequest::from_str(encoded)
        .map_err(|_| "Cashu payment request is invalid".to_owned())?;
    let id = request
        .payment_id
        .ok_or_else(|| "Cashu payment request is incomplete".to_owned())?;
    validate_protocol_id(&id)?;
    let amount = request
        .amount
        .ok_or_else(|| "Cashu payment request is incomplete".to_owned())?
        .to_u64();
    let unit = request
        .unit
        .ok_or_else(|| "Cashu payment request is incomplete".to_owned())?
        .to_string();
    if amount == 0 || amount > MAX_SAFE_INTEGER || request.single_use != Some(true) {
        return Err("Cashu payment request is incomplete".to_owned());
    }
    let mints = request
        .mints
        .iter()
        .map(|mint| normalize_mint_url(&mint.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    if mints.is_empty() {
        return Err("Cashu payment request is incomplete".to_owned());
    }
    let target = request
        .transports
        .iter()
        .find(|transport| transport._type == TransportType::HttpPost)
        .map(|transport| transport.target.clone())
        .ok_or_else(|| "Cashu payment request is incomplete".to_owned())?;
    validate_http_target(&target)?;
    Ok(ParsedRequest {
        id,
        amount,
        unit,
        mints,
        target,
    })
}

fn validate_reserved(reserved: &ReservedProofs, amount: u64) -> Result<(), String> {
    if reserved.proofs.is_empty() || reserved.proofs.len() > 256 {
        return Err("CDK wallet returned an invalid proof reservation".to_owned());
    }
    let total = reserved.proofs.iter().try_fold(0_u64, |total, proof| {
        let proof_amount = proof
            .get("amount")
            .and_then(JsonValue::as_u64)
            .ok_or_else(|| "CDK wallet returned an invalid proof reservation".to_owned())?;
        for field in ["id", "secret", "C"] {
            if proof
                .get(field)
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                return Err("CDK wallet returned an invalid proof reservation".to_owned());
            }
        }
        total
            .checked_add(proof_amount)
            .ok_or_else(|| "CDK wallet returned an invalid proof reservation".to_owned())
    })?;
    if total < amount || reserved.input_ys.len() != reserved.proofs.len() {
        return Err("CDK wallet returned an invalid proof reservation".to_owned());
    }
    if !is_hash(&reserved.proof_set_hash)
        || reserved
            .input_ys
            .iter()
            .any(|value| !is_compressed_point_hex(value))
    {
        return Err("CDK wallet returned invalid proof evidence".to_owned());
    }
    Ok(())
}

fn validate_receipt(
    receipt: &DeliveryReceipt,
    record: &StoredDelivery,
    delivery_id: &str,
) -> Result<(), String> {
    if receipt.profile != "cashu-delivery-v1"
        || receipt.request_id != record.request_id
        || receipt.delivery_id != delivery_id
        || receipt.payload_hash != record.payload_hash
        || receipt.mint != record.mint
        || receipt.unit != record.unit
        || receipt.amount != record.amount
        || !matches!(
            receipt.status.as_str(),
            "processing" | "settled" | "rejected"
        )
        || receipt.status_version == 0
        || receipt.detail_code.is_empty()
    {
        return Err("Cashu receiver receipt does not match the persisted payment".to_owned());
    }
    if let Some(previous) = &record.receipt
        && (receipt.status_version < previous.status_version
            || (receipt.status_version == previous.status_version && receipt != previous)
            || matches!(previous.status.as_str(), "settled" | "rejected") && receipt != previous)
    {
        return Err("Cashu receiver receipt status regressed".to_owned());
    }
    Ok(())
}

pub fn payload_hash_from_json(payload: &JsonValue) -> Result<String, String> {
    let delivery = payload
        .get("delivery")
        .ok_or_else(|| "Delivery payload is invalid".to_owned())?;
    payload_hash(
        payload
            .get("id")
            .and_then(JsonValue::as_str)
            .unwrap_or_default(),
        payload.get("memo").and_then(JsonValue::as_str),
        payload
            .get("mint")
            .and_then(JsonValue::as_str)
            .unwrap_or_default(),
        payload
            .get("unit")
            .and_then(JsonValue::as_str)
            .unwrap_or_default(),
        payload
            .get("proofs")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| "Delivery payload is invalid".to_owned())?,
        delivery
            .get("created_at")
            .and_then(JsonValue::as_u64)
            .unwrap_or(u64::MAX),
        delivery
            .get("expires_at")
            .and_then(JsonValue::as_u64)
            .unwrap_or(u64::MAX),
    )
}

pub fn payload_hash(
    request_id: &str,
    memo: Option<&str>,
    mint: &str,
    unit: &str,
    proofs: &[JsonValue],
    created_at: u64,
    expires_at: u64,
) -> Result<String, String> {
    validate_protocol_id(request_id)?;
    if unit.is_empty()
        || proofs.len() > 256
        || created_at > MAX_SAFE_INTEGER
        || expires_at > MAX_SAFE_INTEGER
        || expires_at <= created_at
        || expires_at - created_at > 86_400
    {
        return Err("Payload fingerprint input is invalid".to_owned());
    }
    let proofs = proofs
        .iter()
        .map(json_to_cbor)
        .collect::<Result<Vec<_>, _>>()?;
    let value = CborValue::Array(vec![
        CborValue::Text("cashu-delivery-v1/payload".to_owned()),
        CborValue::Text(request_id.to_owned()),
        memo.map_or(CborValue::Null, |value| CborValue::Text(value.to_owned())),
        CborValue::Text(normalize_mint_url(mint)?),
        CborValue::Text(unit.to_owned()),
        CborValue::Array(proofs),
        CborValue::Integer(1_u64.into()),
        CborValue::Integer(created_at.into()),
        CborValue::Integer(expires_at.into()),
    ]);
    let mut encoded = Vec::new();
    ciborium::into_writer(&value, &mut encoded).map_err(stable_error)?;
    Ok(hash_bytes(&encoded))
}

pub fn proof_set_hash(mint: &str, unit: &str, input_ys: &[String]) -> Result<String, String> {
    if unit.is_empty() {
        return Err("Proof-set fingerprint input is invalid".to_owned());
    }
    let mut ys = input_ys
        .iter()
        .map(|value| {
            if !is_compressed_point_hex(value) {
                return Err("Proof-set fingerprint input is invalid".to_owned());
            }
            hex::decode(value).map_err(|_| "Proof-set fingerprint input is invalid".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    ys.sort();
    if ys.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("Proof-set fingerprint contains duplicate proof points".to_owned());
    }
    let value = CborValue::Array(vec![
        CborValue::Text("cashu-delivery-v1/proof-set".to_owned()),
        CborValue::Text(normalize_mint_url(mint)?),
        CborValue::Text(unit.to_owned()),
        CborValue::Array(ys.into_iter().map(CborValue::Bytes).collect()),
    ]);
    let mut encoded = Vec::new();
    ciborium::into_writer(&value, &mut encoded).map_err(stable_error)?;
    Ok(hash_bytes(&encoded))
}

fn json_to_cbor(value: &JsonValue) -> Result<CborValue, String> {
    match value {
        JsonValue::Null => Ok(CborValue::Null),
        JsonValue::Bool(value) => Ok(CborValue::Bool(*value)),
        JsonValue::String(value) => Ok(CborValue::Text(value.clone())),
        JsonValue::Number(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(|value| CborValue::Integer(value.into()))
            .ok_or_else(|| "Payload proofs contain an invalid number".to_owned()),
        JsonValue::Array(values) => values
            .iter()
            .map(json_to_cbor)
            .collect::<Result<Vec<_>, _>>()
            .map(CborValue::Array),
        JsonValue::Object(values) => {
            let mut entries = values
                .iter()
                .map(|(key, value)| Ok((CborValue::Text(key.clone()), json_to_cbor(value)?)))
                .collect::<Result<Vec<_>, String>>()?;
            entries.sort_by(|(left, _), (right, _)| {
                CanonicalValue::from(left.clone()).cmp(&CanonicalValue::from(right.clone()))
            });
            Ok(CborValue::Map(entries))
        }
    }
}

pub fn normalize_mint_url(value: &str) -> Result<String, String> {
    if value != value.trim()
        || value.contains('\\')
        || value.contains('?')
        || value.contains('#')
        || value.split_once("://").is_none()
    {
        return Err("Mint URL is invalid".to_owned());
    }
    let mut url = Url::parse(value).map_err(|_| "Mint URL is invalid".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Mint URL is invalid".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Mint URL is invalid".to_owned())?;
    let loopback = matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    );
    if url.scheme() == "http" && !loopback {
        return Err("Non-loopback mint URL must use HTTPS".to_owned());
    }
    if url.path() == "/" {
        url.set_path("");
    } else if url.path().ends_with('/') {
        let path = url.path().trim_end_matches('/').to_owned();
        url.set_path(&path);
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn validate_http_target(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "Cashu payment target is invalid".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Cashu payment target is invalid".to_owned());
    }
    Ok(())
}

fn protocol_id(seed: &str, request_id: &str, ordinal: u64) -> String {
    let material =
        format!("cashu-fault-lab/cdk-funded-delivery-v1\0{seed}\0{request_id}\0{ordinal}");
    URL_SAFE_NO_PAD.encode(&sha256::Hash::hash(material.as_bytes()).to_byte_array()[..16])
}

fn validate_protocol_id(value: &str) -> Result<(), String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "Protocol ID is invalid".to_owned())?;
    if decoded.len() != 16 || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err("Protocol ID is invalid".to_owned());
    }
    Ok(())
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_compressed_point_hex(value: &str) -> bool {
    value.len() == 66
        && matches!(value.get(..2), Some("02" | "03"))
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn hash_bytes(value: &[u8]) -> String {
    sha256::Hash::hash(value).to_string()
}

fn stable_error(error: impl std::fmt::Display) -> String {
    format!("CDK adapter serialization failed: {error}")
}
