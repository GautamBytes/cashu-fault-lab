use super::{
    Output, Plan, Result,
    protocol::{Zap, amount, local_url},
};
use cdk::{
    Amount, dhke,
    nuts::{BlindSignature, BlindedMessage, KeySet, KeySetInfo, Proof, SecretKey},
    secret::Secret,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

#[derive(Deserialize)]
struct Keysets<T> {
    keysets: Vec<T>,
}
#[derive(Deserialize, Serialize)]
struct BlindPlan {
    message: BlindedMessage,
    secret: Secret,
    r: SecretKey,
}

pub struct Mint {
    url: String,
    client: reqwest::Client,
    keys: BTreeMap<String, KeySet>,
    metadata: Vec<KeySetInfo>,
    lock: SecretKey,
}

impl Mint {
    pub async fn new(url: &str, lock: &str) -> Result<Self> {
        local_url(url, "http")?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "mint_client_failed")?;
        let mut mint = Self {
            url: url.trim_end_matches('/').to_owned(),
            client,
            keys: BTreeMap::new(),
            metadata: vec![],
            lock: lock.parse().map_err(|_| "invalid_lock_key")?,
        };
        let response: Keysets<KeySetInfo> = mint.request("v1/keysets", None).await?;
        if response.keysets.is_empty() || response.keysets.len() > 64 {
            return Err("invalid_keysets");
        }
        mint.metadata = response.keysets;
        for info in &mint.metadata {
            if info.unit.to_string() != "sat" {
                continue;
            }
            let response: Keysets<KeySet> =
                mint.request(&format!("v1/keys/{}", info.id), None).await?;
            if response.keysets.len() != 1 {
                return Err("invalid_keysets");
            }
            let mut keyset = response
                .keysets
                .into_iter()
                .next()
                .ok_or("invalid_keysets")?;
            if keyset.id != info.id || keyset.unit != info.unit {
                return Err("keyset_mismatch");
            }
            keyset.input_fee_ppk = info.input_fee_ppk;
            keyset.final_expiry = info.final_expiry;
            keyset.verify_id().map_err(|_| "keyset_id_mismatch")?;
            if mint.keys.insert(info.id.to_string(), keyset).is_some() {
                return Err("duplicate_keyset");
            }
        }
        Ok(mint)
    }

    async fn request<T: DeserializeOwned>(&self, path: &str, body: Option<Value>) -> Result<T> {
        let url = format!("{}/{path}", self.url);
        let request = match body {
            Some(body) => self.client.post(url).json(&body),
            None => self.client.get(url),
        };
        let mut response = request.send().await.map_err(|_| "mint_transport_failed")?;
        if !response.status().is_success() {
            return Err("mint_request_rejected");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "mint_transport_failed")?
        {
            if bytes.len() + chunk.len() > 1_048_576 {
                return Err("mint_response_too_large");
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "invalid_mint_response")
    }

    pub fn verify(&self, proofs: &[Proof]) -> Result<()> {
        amount(proofs)?;
        for p in proofs {
            let keys = &self
                .keys
                .get(&p.keyset_id.to_string())
                .ok_or("unknown_keyset")?
                .keys;
            p.verify_dleq(keys.amount_key(p.amount).ok_or("unsupported_amount")?)
                .map_err(|_| "invalid_dleq")?;
        }
        Ok(())
    }

    pub fn prepare(&self, zap: &Zap) -> Result<Plan> {
        Ok(self.prepare_outputs(zap, None)?.plan)
    }
    pub fn prepare_spend(&self, zap: &Zap, amount: u64) -> Result<super::SpendPlan> {
        self.prepare_outputs(zap, Some(amount))
    }
    fn prepare_outputs(&self, zap: &Zap, send: Option<u64>) -> Result<super::SpendPlan> {
        self.verify(&zap.proofs)?;
        let ppk = zap.proofs.iter().try_fold(0_u64, |sum, proof| {
            sum.checked_add(
                self.keys
                    .get(&proof.keyset_id.to_string())
                    .ok_or("unknown_keyset")?
                    .input_fee_ppk,
            )
            .ok_or("invalid_fee")
        })?;
        let fee = ppk.checked_add(999).ok_or("invalid_fee")? / 1000;
        let value = zap
            .amount
            .checked_sub(fee)
            .filter(|v| *v > 0)
            .ok_or("invalid_fee")?;
        let info = self
            .metadata
            .iter()
            .find(|k| k.active && k.unit.to_string() == "sat")
            .ok_or("no_active_keyset")?;
        let keys = &self
            .keys
            .get(&info.id.to_string())
            .ok_or("unknown_keyset")?
            .keys;
        let mut saved = Vec::new();
        let mut outputs = Vec::new();
        let parts = match send {
            Some(n) if n > 0 && n < value => vec![n, value - n],
            Some(_) => return Err("invalid_partial_spend"),
            None => vec![value],
        };
        let mut send_secrets = Vec::new();
        for (index, value) in parts.into_iter().enumerate() {
            for bit in 0..20 {
                let part = 1_u64 << bit;
                if value & part == 0 {
                    continue;
                }
                let amount = Amount::from(part);
                if keys.amount_key(amount).is_none() {
                    return Err("unsupported_amount");
                }
                let secret = Secret::generate();
                let (blinded, r) =
                    dhke::blind_message(&secret.to_bytes(), None).map_err(|_| "blinding_failed")?;
                outputs.push(Output {
                    id: info.id.to_string(),
                    amount: part,
                    secret: secret.to_string(),
                });
                if send.is_some() && index == 0 {
                    send_secrets.push(secret.to_string());
                }
                saved.push(BlindPlan {
                    message: BlindedMessage::new(amount, info.id, blinded),
                    secret,
                    r,
                });
            }
        }
        Ok(super::SpendPlan {
            plan: Plan {
                outputs,
                fee,
                material: serde_json::to_string(&saved).map_err(|_| "invalid_plan")?,
            },
            send_secrets,
        })
    }

    pub async fn states(&self, proofs: &[Proof]) -> Result<Vec<String>> {
        let ys: Vec<_> = proofs
            .iter()
            .map(|p| p.y().map(|y| y.to_string()))
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| "invalid_proof")?;
        let result: Value = self
            .request("v1/checkstate", Some(json!({"Ys": ys})))
            .await?;
        let rows = result["states"].as_array().ok_or("invalid_states")?;
        let mut states = BTreeMap::new();
        for row in rows {
            let y = row["Y"].as_str().ok_or("invalid_states")?;
            let state = row["state"].as_str().ok_or("invalid_states")?;
            if !ys.iter().any(|v| v == y)
                || !["SPENT", "UNSPENT", "PENDING"].contains(&state)
                || states.insert(y, state).is_some()
            {
                return Err("uncorrelated_states");
            }
        }
        if states.len() != ys.len() {
            return Err("incomplete_states");
        }
        ys.iter()
            .map(|y| {
                states
                    .get(y.as_str())
                    .map(|s| (*s).to_owned())
                    .ok_or("incomplete_states")
            })
            .collect()
    }

    fn unblind(&self, saved: &[BlindPlan], signatures: Vec<BlindSignature>) -> Result<Vec<Proof>> {
        if saved.len() != signatures.len() {
            return Err("restore_cardinality");
        }
        let mut proofs = Vec::new();
        for (plan, signature) in saved.iter().zip(signatures) {
            if signature.keyset_id != plan.message.keyset_id
                || signature.amount != plan.message.amount
            {
                return Err("output_mismatch");
            }
            let keys = &self
                .keys
                .get(&signature.keyset_id.to_string())
                .ok_or("unknown_keyset")?
                .keys;
            signature
                .verify_dleq(
                    keys.amount_key(signature.amount)
                        .ok_or("unsupported_amount")?,
                    plan.message.blinded_secret,
                )
                .map_err(|_| "invalid_dleq")?;
            proofs.extend(
                dhke::construct_proofs(
                    vec![signature],
                    vec![plan.r.clone()],
                    vec![plan.secret.clone()],
                    keys,
                )
                .map_err(|_| "unblinding_failed")?,
            );
        }
        if !proofs.is_empty() {
            self.verify(&proofs)?;
        }
        Ok(proofs)
    }

    pub async fn swap(&self, zap: &Zap, plan: &Plan) -> Result<Vec<Proof>> {
        let saved: Vec<BlindPlan> =
            serde_json::from_str(&plan.material).map_err(|_| "invalid_plan")?;
        let mut inputs = zap.proofs.clone();
        for proof in &mut inputs {
            if serde_json::from_str::<Value>(&proof.secret.to_string())
                .ok()
                .is_some_and(|v| v[0] == "P2PK")
            {
                proof
                    .sign_p2pk(self.lock.clone())
                    .map_err(|_| "p2pk_signing_failed")?;
            }
        }
        let result: Value = self.request("v1/swap", Some(json!({"inputs": inputs, "outputs": saved.iter().map(|s| &s.message).collect::<Vec<_>>()}))).await?;
        let signatures = serde_json::from_value(result["signatures"].clone())
            .map_err(|_| "invalid_swap_response")?;
        self.unblind(&saved, signatures)
    }

    pub async fn restore(&self, plan: &Plan) -> Result<Vec<Proof>> {
        let saved: Vec<BlindPlan> =
            serde_json::from_str(&plan.material).map_err(|_| "invalid_plan")?;
        let result: Value = self
            .request(
                "v1/restore",
                Some(json!({"outputs": saved.iter().map(|s| &s.message).collect::<Vec<_>>()})),
            )
            .await?;
        let outputs: Vec<BlindedMessage> =
            serde_json::from_value(result["outputs"].clone()).map_err(|_| "invalid_restore")?;
        let signatures: Vec<BlindSignature> =
            serde_json::from_value(result["signatures"].clone()).map_err(|_| "invalid_restore")?;
        if outputs.len() != signatures.len() {
            return Err("restore_cardinality");
        }
        let mut matched = Vec::new();
        let mut seen = BTreeSet::new();
        for output in outputs {
            if !seen.insert(output.blinded_secret.to_string()) {
                return Err("duplicate_restore_output");
            }
            let Some(original) = saved.iter().find(|s| s.message == output) else {
                return Err("restore_output_mismatch");
            };
            matched.push(BlindPlan {
                message: original.message.clone(),
                secret: original.secret.clone(),
                r: original.r.clone(),
            });
        }
        self.unblind(&matched, signatures)
    }
}
