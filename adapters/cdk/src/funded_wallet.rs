use std::{collections::HashMap, str::FromStr, sync::Arc, time::Duration};

use async_trait::async_trait;
use bitcoin::hashes::{Hash, sha512};
use cdk::{
    Amount, Wallet,
    nuts::{CurrencyUnit, PaymentMethod},
    wallet::{KeysetFilter, SendOptions},
};
use tokio::sync::Mutex;

use crate::funded::{ReservedProofs, WalletPort, normalize_mint_url, proof_set_hash};

struct Reservation {
    amount: u64,
    unit: String,
    value: ReservedProofs,
    settled: bool,
}

#[derive(Default)]
struct WalletState {
    wallet: Option<Arc<Wallet>>,
    reservations: HashMap<String, Reservation>,
}

pub struct FundedCdkWallet {
    mint_url: String,
    unit: CurrencyUnit,
    funding_amount: u64,
    funding_timeout: Duration,
    state: Mutex<WalletState>,
}

impl FundedCdkWallet {
    pub fn new(
        mint_url: &str,
        unit: &str,
        funding_amount: u64,
        funding_timeout: Duration,
    ) -> Result<Self, String> {
        if funding_amount == 0 {
            return Err("CDK funding amount must be positive".to_owned());
        }
        let mint_url = normalize_mint_url(mint_url)?;
        let unit =
            CurrencyUnit::from_str(unit).map_err(|_| "CDK wallet unit is invalid".to_owned())?;
        Ok(Self {
            mint_url,
            unit,
            funding_amount,
            funding_timeout,
            state: Mutex::new(WalletState::default()),
        })
    }
}

#[async_trait]
impl WalletPort for FundedCdkWallet {
    async fn reset(&self, seed: &str) -> Result<(), String> {
        if seed.is_empty() {
            return Err("CDK wallet seed is required".to_owned());
        }
        // CDK derives blinded outputs deterministically from its seed and a fresh database starts
        // counters at zero. Mix per-reset OS entropy into this ephemeral test wallet so replaying a
        // seeded lab scenario never resubmits blinded outputs an already-used mint has signed.
        let mut reset_entropy = [0_u8; 32];
        getrandom::fill(&mut reset_entropy)
            .map_err(|_| "CDK wallet entropy initialization failed".to_owned())?;
        let mut seed_material = b"cashu-fault-lab/cdk-wallet-seed-v1\0".to_vec();
        seed_material.extend_from_slice(seed.as_bytes());
        seed_material.push(0);
        seed_material.extend_from_slice(&reset_entropy);
        let wallet_seed = sha512::Hash::hash(&seed_material).to_byte_array();
        let localstore = Arc::new(
            cdk_sqlite::wallet::memory::empty()
                .await
                .map_err(|_| "CDK wallet database initialization failed".to_owned())?,
        );
        let wallet = Arc::new(
            Wallet::new(
                &self.mint_url,
                self.unit.clone(),
                localstore,
                wallet_seed,
                None,
            )
            .map_err(|_| "CDK wallet initialization failed".to_owned())?,
        );
        wallet
            .recover_incomplete_sagas()
            .await
            .map_err(|_| "CDK wallet recovery failed".to_owned())?;
        let quote = wallet
            .mint_quote(
                PaymentMethod::BOLT11,
                Some(Amount::from(self.funding_amount)),
                Some("cashu-fault-lab funded adapter".to_owned()),
                None,
            )
            .await
            .map_err(|_| "CDK wallet funding quote failed".to_owned())?;
        wallet
            .wait_and_mint_quote(
                quote,
                Default::default(),
                Default::default(),
                self.funding_timeout,
            )
            .await
            .map_err(|_| "CDK wallet funding failed".to_owned())?;
        *self.state.lock().await = WalletState {
            wallet: Some(wallet),
            reservations: HashMap::new(),
        };
        Ok(())
    }

    async fn reserve(
        &self,
        amount: u64,
        unit: &str,
        mints: &[String],
        delivery_id: &str,
    ) -> Result<ReservedProofs, String> {
        let mut state = self.state.lock().await;
        if let Some(existing) = state.reservations.get(delivery_id) {
            if existing.amount != amount || existing.unit != unit {
                return Err("CDK delivery reservation identity conflicts".to_owned());
            }
            return Ok(existing.value.clone());
        }
        if unit != self.unit.to_string() || !mints.iter().any(|mint| mint == &self.mint_url) {
            return Err("CDK wallet cannot satisfy the requested mint or unit".to_owned());
        }
        let wallet = state
            .wallet
            .clone()
            .ok_or_else(|| "CDK wallet is not funded".to_owned())?;
        let prepared = wallet
            .prepare_send(
                Amount::from(amount),
                SendOptions {
                    include_fee: true,
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| "CDK wallet proof reservation failed".to_owned())?;
        let token = prepared
            .confirm(None)
            .await
            .map_err(|_| "CDK wallet proof reservation failed".to_owned())?;
        let keysets = wallet
            .get_mint_keysets(KeysetFilter::All)
            .await
            .map_err(|_| "CDK wallet keyset lookup failed".to_owned())?;
        let proofs = token
            .proofs(&keysets)
            .map_err(|_| "CDK wallet token decoding failed".to_owned())?;
        let total = proofs.iter().try_fold(0_u64, |sum, proof| {
            sum.checked_add(proof.amount.to_u64())
                .ok_or_else(|| "CDK wallet returned an invalid proof reservation".to_owned())
        })?;
        if proofs.is_empty() || total < amount {
            return Err("CDK wallet returned an invalid proof reservation".to_owned());
        }
        let input_ys = proofs
            .iter()
            .map(|proof| {
                proof
                    .y()
                    .map(|point| point.to_string())
                    .map_err(|_| "CDK wallet proof evidence failed".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let proof_values = proofs
            .iter()
            .map(|proof| {
                serde_json::to_value(proof)
                    .map_err(|_| "CDK wallet proof serialization failed".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let value = ReservedProofs {
            mint: self.mint_url.clone(),
            proofs: proof_values,
            proof_set_hash: proof_set_hash(&self.mint_url, unit, &input_ys)?,
            input_ys,
        };
        state.reservations.insert(
            delivery_id.to_owned(),
            Reservation {
                amount,
                unit: unit.to_owned(),
                value: value.clone(),
                settled: false,
            },
        );
        Ok(value)
    }

    async fn mark_settled(&self, delivery_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let reservation = state
            .reservations
            .get_mut(delivery_id)
            .ok_or_else(|| "CDK delivery reservation was not found".to_owned())?;
        reservation.settled = true;
        Ok(())
    }
}
