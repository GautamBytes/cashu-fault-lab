use std::{collections::HashMap, fmt, path::PathBuf, str::FromStr, sync::Arc};

use async_trait::async_trait;
use bitcoin::hashes::{Hash, sha256, sha512};
use cdk::{
    Amount, Wallet,
    amount::SplitTarget,
    nuts::{
        CurrencyUnit, MeltQuoteState, MintQuoteState, PaymentMethod, Proofs, State, Token,
        nut00::ProofsMethods,
    },
    wallet::{MeltOutcome, ReceiveOptions, SendKind, SendOptions},
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::lifecycle_store::LifecycleStore;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleKind {
    Mint,
    Swap,
    Send,
    Receive,
    Melt,
    Restore,
    Reconcile,
}

impl fmt::Display for LifecycleKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Mint => "mint",
            Self::Swap => "swap",
            Self::Send => "send",
            Self::Receive => "receive",
            Self::Melt => "melt",
            Self::Restore => "restore",
            Self::Reconcile => "reconcile",
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecyclePhase {
    Created,
    Prepared,
    Submitted,
    Ambiguous,
    Reconciling,
    Succeeded,
    FailedDefinitive,
    RecoveryBlocked,
}

impl LifecyclePhase {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::FailedDefinitive | Self::RecoveryBlocked
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleInput {
    pub operation_id: String,
    pub kind: LifecycleKind,
    pub mint: String,
    pub unit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    /// Token for receive or invoice for melt. This is encrypted at rest and never returned.
    #[serde(
        rename = "token",
        alias = "invoice",
        skip_serializing_if = "Option::is_none"
    )]
    pub secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer_async: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleOperation {
    pub operation_id: String,
    pub kind: LifecycleKind,
    pub mint: String,
    pub unit: String,
    pub intent_hash: String,
    pub phase: LifecyclePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_fee: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_reserve: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_fee: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_plan_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEvidence {
    pub sequence: u64,
    pub operation_id: String,
    pub source: String,
    pub event: String,
    pub data_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleProofView {
    pub proof_id: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleBalances {
    pub available: u64,
    pub reserved: u64,
    pub recoverable: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleWalletView {
    pub wallet_id: String,
    pub mint: String,
    pub unit: String,
    pub balances: LifecycleBalances,
    pub proofs: Vec<LifecycleProofView>,
}

pub struct LifecycleRuntimeCapabilities {
    pub operations: Vec<&'static str>,
    pub nuts: Vec<u16>,
    pub recovery: Vec<&'static str>,
}

#[derive(Clone, Debug)]
pub struct LifecycleExecution {
    phase: LifecyclePhase,
    evidence_code: Option<&'static str>,
    event: String,
    amount: Option<u64>,
    input_fee: Option<u64>,
    fee_reserve: Option<u64>,
    actual_fee: Option<u64>,
    change: Option<u64>,
    private_material: Option<Vec<u8>>,
    send_handoff: Option<LifecycleSendHandoff>,
}

#[derive(Clone, Debug)]
pub struct LifecycleSendHandoff {
    pub recipient: String,
    pub token: String,
}

impl LifecycleExecution {
    pub fn succeeded(amount: Option<u64>, event: impl Into<String>) -> Self {
        Self {
            phase: LifecyclePhase::Succeeded,
            evidence_code: None,
            event: event.into(),
            amount,
            input_fee: None,
            fee_reserve: None,
            actual_fee: None,
            change: None,
            private_material: None,
            send_handoff: None,
        }
    }

    pub fn ambiguous(code: &'static str) -> Self {
        Self::failure(LifecyclePhase::Ambiguous, code)
    }

    pub fn failed_definitive(code: &'static str) -> Self {
        Self::failure(LifecyclePhase::FailedDefinitive, code)
    }

    pub fn recovery_blocked(code: &'static str) -> Self {
        Self::failure(LifecyclePhase::RecoveryBlocked, code)
    }

    pub fn melt_recovered(fee_reserve: u64) -> Self {
        let mut execution = Self::succeeded(None, "melt_reconciled");
        execution.fee_reserve = Some(fee_reserve);
        execution
    }

    pub fn send_succeeded(amount: u64, recipient: &str, token: &str) -> Self {
        let mut execution = Self::succeeded(Some(amount), "send_observed");
        execution.send_handoff = Some(LifecycleSendHandoff {
            recipient: recipient.to_owned(),
            token: token.to_owned(),
        });
        execution
    }

    pub const fn amount(&self) -> Option<u64> {
        self.amount
    }

    pub const fn fee_reserve(&self) -> Option<u64> {
        self.fee_reserve
    }

    pub const fn actual_fee(&self) -> Option<u64> {
        self.actual_fee
    }

    pub const fn change(&self) -> Option<u64> {
        self.change
    }

    pub const fn evidence_code(&self) -> Option<&'static str> {
        self.evidence_code
    }

    pub fn with_private_material(mut self, material: Vec<u8>) -> Self {
        self.private_material = Some(material);
        self
    }

    pub fn with_fees(
        mut self,
        input_fee: u64,
        fee_reserve: u64,
        actual_fee: u64,
        change: u64,
    ) -> Self {
        self.input_fee = Some(input_fee);
        self.fee_reserve = Some(fee_reserve);
        self.actual_fee = Some(actual_fee);
        self.change = Some(change);
        self
    }

    fn failure(phase: LifecyclePhase, code: &'static str) -> Self {
        Self {
            phase,
            evidence_code: Some(code),
            event: code.to_owned(),
            amount: None,
            input_fee: None,
            fee_reserve: None,
            actual_fee: None,
            change: None,
            private_material: None,
            send_handoff: None,
        }
    }
}

#[async_trait]
pub trait LifecycleWalletPort: Send + Sync {
    async fn reset(&self, seed: &str) -> Result<(), &'static str>;
    async fn reset_generation(&self, seed: &str, _generation: u64) -> Result<(), &'static str> {
        self.reset(seed).await
    }
    async fn rollback_reset(&self) -> Result<(), &'static str> {
        Ok(())
    }
    async fn commit_reset(&self) -> Result<(), &'static str> {
        Ok(())
    }
    async fn prepare(
        &self,
        _request: &LifecycleInput,
    ) -> Result<Option<Vec<u8>>, LifecycleExecution> {
        Ok(None)
    }
    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution;
    async fn execute_prepared(
        &self,
        request: &LifecycleInput,
        _private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        self.execute(request).await
    }
    async fn recover(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> LifecycleExecution;
    async fn wallet(&self) -> Result<LifecycleWalletView, &'static str> {
        Err("wallet_not_configured")
    }
    async fn capabilities(&self) -> Result<LifecycleRuntimeCapabilities, &'static str> {
        Ok(LifecycleRuntimeCapabilities {
            operations: vec![
                "mint",
                "swap",
                "send",
                "receive",
                "melt",
                "restore",
                "reconcile",
            ],
            nuts: vec![3, 4, 5, 7, 8, 9, 13, 23],
            recovery: vec!["quote_state", "proof_state", "nut09_restore", "nut13_seed"],
        })
    }
}

pub struct LifecycleEngine {
    store: Arc<LifecycleStore>,
    wallet: Arc<dyn LifecycleWalletPort>,
    operation_gate: tokio::sync::RwLock<()>,
}

impl LifecycleEngine {
    pub fn new(store: Arc<LifecycleStore>, wallet: Arc<dyn LifecycleWalletPort>) -> Self {
        Self {
            store,
            wallet,
            operation_gate: tokio::sync::RwLock::new(()),
        }
    }

    pub async fn reset(&self, seed: &str) -> Result<(), String> {
        let _exclusive = self.operation_gate.write().await;
        let token = loop {
            if let Some(token) = self.store.try_claim_reset()? {
                break token;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        let generation = self.store.next_generation(token)?;
        let work = self.wallet.reset_generation(seed, generation);
        tokio::pin!(work);
        let wallet_result = loop {
            tokio::select! {
                result = &mut work => break result.map_err(str::to_owned),
                () = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                    self.store.renew_reset(token)?;
                }
            }
        };
        let result = match wallet_result {
            Ok(()) => match self.store.reset(seed, generation, token) {
                Ok(()) => self.wallet.commit_reset().await.map_err(str::to_owned),
                Err(error) => match self.wallet.rollback_reset().await {
                    Ok(()) => Err(error),
                    Err(_) => Err("wallet reset rollback failed".to_owned()),
                },
            },
            Err(error) => Err(error),
        };
        let release = self.store.release_reset(token);
        match (result, release) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) => Err(error),
            (_, Err(error)) => Err(error),
        }
    }

    pub async fn start(&self, mut input: LifecycleInput) -> Result<LifecycleOperation, String> {
        let _operation = self.operation_gate.read().await;
        validate_input(&input)?;
        input.mint = canonical_mint_url(&input.mint)?;
        let capabilities = self.capabilities().await?;
        if !capabilities
            .operations
            .iter()
            .any(|operation| *operation == input.kind.to_string())
        {
            return Err("lifecycle operation is not applicable".to_owned());
        }
        let intent_hash = intent_hash(&input)?;
        let created = LifecycleOperation {
            operation_id: input.operation_id.clone(),
            kind: input.kind,
            mint: input.mint.clone(),
            unit: input.unit.clone(),
            intent_hash,
            phase: LifecyclePhase::Created,
            evidence_code: None,
            amount: input.amount,
            input_fee: None,
            fee_reserve: None,
            actual_fee: None,
            change: None,
            request_hash: None,
            quote_hash: None,
            output_plan_hash: None,
        };
        let (existing, token) = loop {
            if let Some(claimed) = self.store.create_and_claim(&input, &created)? {
                break claimed;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        if existing.intent_hash != created.intent_hash {
            let _ = self.store.release(&input.operation_id, token);
            return Err("lifecycle operation identity conflicts".to_owned());
        }
        self.run_owned(
            &input.operation_id,
            existing.phase != LifecyclePhase::Created,
            token,
        )
        .await
    }

    pub async fn resume(&self, operation_id: &str) -> Result<LifecycleOperation, String> {
        let _operation = self.operation_gate.read().await;
        validate_operation_id(operation_id)?;
        self.run(operation_id, true).await
    }

    pub fn operation(&self, operation_id: &str) -> Result<LifecycleOperation, String> {
        self.store
            .get(operation_id)?
            .ok_or_else(|| "lifecycle operation was not found".to_owned())
    }

    pub async fn wallet(&self) -> Result<LifecycleWalletView, String> {
        self.wallet.wallet().await.map_err(str::to_owned)
    }

    pub fn evidence(&self) -> Result<Vec<LifecycleEvidence>, String> {
        self.store.evidence()
    }

    pub async fn capabilities(&self) -> Result<LifecycleRuntimeCapabilities, String> {
        self.wallet.capabilities().await.map_err(str::to_owned)
    }

    async fn run(&self, operation_id: &str, recovery: bool) -> Result<LifecycleOperation, String> {
        loop {
            let current = self.operation(operation_id)?;
            if current.phase.terminal() {
                return Ok(current);
            }
            if let Some(token) = self.store.try_claim(operation_id)? {
                return self.run_owned(operation_id, recovery, token).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    async fn run_owned(
        &self,
        operation_id: &str,
        recovery: bool,
        token: u64,
    ) -> Result<LifecycleOperation, String> {
        let work = self.run_claimed(operation_id, recovery, token);
        tokio::pin!(work);
        let result = loop {
            tokio::select! {
                result = &mut work => break result,
                () = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                    self.store.renew_claim(operation_id, token)?;
                }
            }
        };
        let release = self.store.release(operation_id, token);
        match (result, release) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (_, Err(error)) => Err(error),
        }
    }

    async fn run_claimed(
        &self,
        operation_id: &str,
        recovery: bool,
        token: u64,
    ) -> Result<LifecycleOperation, String> {
        let input = self.store.input(operation_id)?;
        let mut operation = self.operation(operation_id)?;
        if operation.phase.terminal() {
            return Ok(operation);
        }
        let mut private_material = self.store.private_material(operation_id)?;
        let execution = if recovery || operation.phase == LifecyclePhase::Ambiguous {
            let recovery_from_prepared = operation.phase == LifecyclePhase::Prepared;
            if operation.phase != LifecyclePhase::Reconciling {
                operation.phase = LifecyclePhase::Reconciling;
                operation.evidence_code = None;
                self.store.put(&operation, None, token)?;
            }
            if input.kind == LifecycleKind::Reconcile {
                self.reconcile_execution(&input).await
            } else if recovery_from_prepared && private_material.is_some() {
                self.wallet
                    .execute_prepared(&input, private_material.as_deref())
                    .await
            } else {
                self.wallet
                    .recover(&input, private_material.as_deref())
                    .await
            }
        } else {
            if operation.phase == LifecyclePhase::Created {
                let prepared = self.wallet.prepare(&input).await;
                operation.phase = LifecyclePhase::Prepared;
                operation.request_hash = Some(request_hash(&input)?);
                private_material = match prepared {
                    Ok(material) => material,
                    Err(execution) => {
                        operation.phase = LifecyclePhase::Submitted;
                        self.store.put(&operation, None, token)?;
                        return self.finish_execution(operation, execution, token);
                    }
                };
                operation.output_plan_hash = private_material
                    .as_deref()
                    .map(|material| {
                        hash_parts(b"cashu-fault-lab/cdk-lifecycle-output-plan-v1", &[material])
                    })
                    .or_else(|| output_plan_hash(&input));
                self.store
                    .put(&operation, private_material.as_deref(), token)?;
            }
            operation.phase = LifecyclePhase::Submitted;
            self.store.put(&operation, None, token)?;
            if input.kind == LifecycleKind::Reconcile {
                self.reconcile_execution(&input).await
            } else {
                self.wallet
                    .execute_prepared(&input, private_material.as_deref())
                    .await
            }
        };
        self.finish_execution(operation, execution, token)
    }

    async fn reconcile_execution(&self, input: &LifecycleInput) -> LifecycleExecution {
        let Some(target) = input.target_operation_id.as_deref() else {
            return LifecycleExecution::failed_definitive("reconcile_target_missing");
        };
        match Box::pin(self.run(target, true)).await {
            Ok(operation) => match operation.phase {
                LifecyclePhase::Succeeded => {
                    LifecycleExecution::succeeded(None, "reconcile_observed")
                }
                LifecyclePhase::FailedDefinitive => {
                    LifecycleExecution::failed_definitive("target_failed_definitive")
                }
                LifecyclePhase::RecoveryBlocked => {
                    LifecycleExecution::recovery_blocked("target_recovery_blocked")
                }
                _ => LifecycleExecution::recovery_blocked("target_not_terminal"),
            },
            Err(_) => LifecycleExecution::recovery_blocked("target_recovery_unavailable"),
        }
    }

    fn finish_execution(
        &self,
        mut operation: LifecycleOperation,
        execution: LifecycleExecution,
        token: u64,
    ) -> Result<LifecycleOperation, String> {
        operation.phase = execution.phase;
        operation.evidence_code = execution.evidence_code.map(str::to_owned);
        operation.amount = execution.amount.or(operation.amount);
        operation.input_fee = execution.input_fee;
        operation.fee_reserve = execution.fee_reserve;
        operation.actual_fee = execution.actual_fee;
        operation.change = execution.change;
        let evidence = LifecycleEvidence {
            sequence: 0,
            operation_id: operation.operation_id.clone(),
            source: "adapter".to_owned(),
            event: execution.event,
            data_hash: evidence_hash(&operation),
        };
        self.store.commit(
            &operation,
            execution.private_material.as_deref(),
            &format!("{}.{}", operation.operation_id, evidence.event),
            &evidence,
            execution.send_handoff.as_ref(),
            token,
        )?;
        Ok(operation)
    }
}

fn validate_input(input: &LifecycleInput) -> Result<(), String> {
    validate_operation_id(&input.operation_id)?;
    if input.mint.len() > 2048 {
        return Err("lifecycle mint URL is invalid".to_owned());
    }
    if canonical_mint_url(&input.mint)? != input.mint {
        return Err("lifecycle mint URL is invalid".to_owned());
    }
    if input.unit.is_empty()
        || input.unit.len() > 16
        || !input
            .unit
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
    {
        return Err("lifecycle unit is invalid".to_owned());
    }
    match input.kind {
        LifecycleKind::Mint => {
            if input
                .amount
                .is_none_or(|amount| amount == 0 || amount > 9_007_199_254_740_991)
            {
                return Err("lifecycle amount is invalid".to_owned());
            }
            if input.method.as_deref() != Some("bolt11")
                || input.recipient.is_some()
                || input.secret.is_some()
                || input.prefer_async.is_some()
                || input.target_operation_id.is_some()
            {
                return Err("lifecycle mint request is invalid".to_owned());
            }
        }
        LifecycleKind::Swap => {
            if input
                .amount
                .is_none_or(|amount| amount == 0 || amount > 9_007_199_254_740_991)
                || input.method.is_some()
                || input.recipient.is_some()
                || input.secret.is_some()
                || input.prefer_async.is_some()
                || input.target_operation_id.is_some()
            {
                return Err("lifecycle swap request is invalid".to_owned());
            }
        }
        LifecycleKind::Send => {
            let valid_recipient = input.recipient.as_ref().is_some_and(|recipient| {
                !recipient.is_empty()
                    && recipient.len() <= 64
                    && recipient.bytes().enumerate().all(|(index, byte)| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || (index > 0 && b"_.-".contains(&byte))
                    })
            });
            if input
                .amount
                .is_none_or(|amount| amount == 0 || amount > 9_007_199_254_740_991)
                || !valid_recipient
                || input.method.is_some()
                || input.secret.is_some()
                || input.prefer_async.is_some()
                || input.target_operation_id.is_some()
            {
                return Err("lifecycle send request is invalid".to_owned());
            }
        }
        LifecycleKind::Receive => {
            if input
                .secret
                .as_ref()
                .is_none_or(|secret| secret.is_empty() || secret.len() > 262_144)
                || input.amount.is_some()
                || input.method.is_some()
                || input.recipient.is_some()
                || input.prefer_async.is_some()
                || input.target_operation_id.is_some()
            {
                return Err("lifecycle receive request is invalid".to_owned());
            }
        }
        LifecycleKind::Melt => {
            if input
                .secret
                .as_ref()
                .is_none_or(|secret| secret.is_empty() || secret.len() > 16_384)
                || input.amount.is_some()
                || input.method.is_some()
                || input.recipient.is_some()
                || input.target_operation_id.is_some()
            {
                return Err("lifecycle melt request is invalid".to_owned());
            }
        }
        LifecycleKind::Reconcile => {
            let target = input
                .target_operation_id
                .as_deref()
                .ok_or_else(|| "lifecycle reconciliation target is required".to_owned())?;
            validate_operation_id(target)?;
            if target == input.operation_id {
                return Err("lifecycle reconciliation target is invalid".to_owned());
            }
            if input.amount.is_some()
                || input.method.is_some()
                || input.recipient.is_some()
                || input.secret.is_some()
                || input.prefer_async.is_some()
            {
                return Err("lifecycle reconcile request is invalid".to_owned());
            }
        }
        LifecycleKind::Restore => {
            if input.amount.is_some()
                || input.method.is_some()
                || input.recipient.is_some()
                || input.secret.is_some()
                || input.prefer_async.is_some()
                || input.target_operation_id.is_some()
            {
                return Err("lifecycle restore request is invalid".to_owned());
            }
        }
    }
    Ok(())
}

fn canonical_mint_url(value: &str) -> Result<String, String> {
    let mint = url::Url::parse(value).map_err(|_| "lifecycle mint URL is invalid")?;
    if !matches!(mint.scheme(), "http" | "https")
        || !mint.username().is_empty()
        || mint.password().is_some()
        || mint.query().is_some()
        || mint.fragment().is_some()
    {
        return Err("lifecycle mint URL is invalid".to_owned());
    }
    let path = if mint.path() == "/" {
        ""
    } else {
        mint.path().trim_end_matches('/')
    };
    let host = mint
        .host_str()
        .ok_or_else(|| "lifecycle mint URL is invalid".to_owned())?;
    let authority = match mint.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    Ok(format!("{}://{authority}{path}", mint.scheme()))
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    let valid = value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        && matches!(value.as_bytes().last(), Some(b'A' | b'Q' | b'g' | b'w'));
    if valid {
        Ok(())
    } else {
        Err("lifecycle operation ID is invalid".to_owned())
    }
}

fn hash_parts(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut bytes = domain.to_vec();
    for part in parts {
        bytes.push(0);
        bytes.extend_from_slice(part);
    }
    sha256::Hash::hash(&bytes).to_string()
}

fn intent_hash(input: &LifecycleInput) -> Result<String, String> {
    let encoded = serde_json::to_vec(input).map_err(|_| "lifecycle intent encoding failed")?;
    Ok(hash_parts(
        b"cashu-fault-lab/cdk-lifecycle-intent-v1",
        &[&encoded],
    ))
}

fn request_hash(input: &LifecycleInput) -> Result<String, String> {
    let encoded = serde_json::to_vec(input).map_err(|_| "lifecycle request encoding failed")?;
    Ok(hash_parts(
        b"cashu-fault-lab/cdk-lifecycle-request-v1",
        &[&encoded],
    ))
}

fn output_plan_hash(input: &LifecycleInput) -> Option<String> {
    matches!(
        input.kind,
        LifecycleKind::Mint
            | LifecycleKind::Swap
            | LifecycleKind::Send
            | LifecycleKind::Receive
            | LifecycleKind::Restore
    )
    .then(|| {
        hash_parts(
            b"cashu-fault-lab/cdk-lifecycle-output-plan-v1",
            &[input.operation_id.as_bytes()],
        )
    })
}

fn evidence_hash(operation: &LifecycleOperation) -> String {
    let public = format!(
        "{}:{}:{}:{}:{}",
        operation.operation_id,
        operation.kind,
        operation.phase as u8,
        operation.amount.unwrap_or_default(),
        operation.evidence_code.as_deref().unwrap_or_default()
    );
    hash_parts(
        b"cashu-fault-lab/cdk-lifecycle-evidence-v1",
        &[public.as_bytes()],
    )
}

pub fn deterministic_exact_amount_plan(
    mut proofs: Vec<(String, u64)>,
    amount: u64,
) -> Option<Vec<String>> {
    proofs.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let mut remaining = amount;
    let mut selected = Vec::new();
    for (proof_id, proof_amount) in proofs {
        if proof_amount <= remaining {
            remaining -= proof_amount;
            selected.push(proof_id);
        }
        if remaining == 0 {
            return Some(selected);
        }
    }
    None
}

pub fn operation_bound_recovery_mechanisms(
    operations: &[&str],
    supports_quote_state: bool,
    supports_proof_state: bool,
    supports_restore: bool,
    supports_replay: bool,
) -> Vec<&'static str> {
    let mut recovery = Vec::new();
    if supports_quote_state
        && operations
            .iter()
            .any(|operation| matches!(*operation, "mint" | "melt"))
    {
        recovery.push("quote_state");
    }
    if supports_proof_state && operations.contains(&"swap") {
        recovery.push("proof_state");
    }
    if supports_restore && operations.contains(&"restore") {
        recovery.extend(["nut09_restore", "nut13_seed"]);
    }
    if supports_replay && operations.contains(&"swap") {
        recovery.push("nut19_replay");
    }
    recovery
}

fn select_exact_proofs(proofs: Proofs, amount: u64) -> Option<Proofs> {
    let mut by_id = HashMap::new();
    let mut summaries = Vec::with_capacity(proofs.len());
    for proof in proofs {
        let id = proof.y().ok()?.to_string();
        summaries.push((id.clone(), proof.amount.to_u64()));
        by_id.insert(id, proof);
    }
    deterministic_exact_amount_plan(summaries, amount).map(|plan| {
        plan.into_iter()
            .filter_map(|id| by_id.remove(&id))
            .collect()
    })
}

fn remove_wallet_files(path: &std::path::Path) -> Result<(), &'static str> {
    for path in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("wallet_database_reset_failed"),
        }
    }
    Ok(())
}

/// Native CDK 0.17 wallet implementation. CDK's default mint connector disables redirects and
/// its saga recovery APIs are used on resume; no TypeScript wallet code is involved.
pub struct NativeCdkLifecycleWallet {
    mint_url: String,
    unit: CurrencyUnit,
    database_path: PathBuf,
    database_password: String,
    wallet: Mutex<Option<Arc<Wallet>>>,
    reset_previous: Mutex<Option<Arc<Wallet>>>,
    reset_new_path: Mutex<Option<PathBuf>>,
    facade: Option<Arc<dyn NativeCdkFacade>>,
}

#[async_trait]
pub trait NativeCdkFacade: Send + Sync {
    async fn reset(&self, seed: &str) -> Result<(), String>;
    async fn rollback_reset(&self) -> Result<(), String> {
        Ok(())
    }
    async fn commit_reset(&self) -> Result<(), String> {
        Ok(())
    }
    async fn prepare(&self, request: &LifecycleInput) -> Result<Option<Vec<u8>>, String>;
    async fn execute(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> Result<LifecycleExecution, String>;
    async fn recover(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> Result<LifecycleExecution, String>;
    async fn wallet(&self) -> Result<LifecycleWalletView, String>;
    async fn capabilities(&self) -> Result<LifecycleRuntimeCapabilities, String>;
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum NativePreparedPlan {
    Swap {
        amount: u64,
        proofs: Proofs,
    },
    Send {
        amount: u64,
        recipient: String,
        operation_id: String,
        proofs_to_swap: Proofs,
        proofs_to_send: Proofs,
        swap_fee: u64,
        send_fee: u64,
        token: String,
    },
}

impl NativeCdkLifecycleWallet {
    pub const fn operation_bound(kind: LifecycleKind) -> bool {
        matches!(
            kind,
            LifecycleKind::Mint
                | LifecycleKind::Swap
                | LifecycleKind::Send
                | LifecycleKind::Receive
                | LifecycleKind::Melt
                | LifecycleKind::Restore
                | LifecycleKind::Reconcile
        )
    }

    pub const fn aggregate_recovery_phase(_kind: LifecycleKind) -> LifecyclePhase {
        LifecyclePhase::RecoveryBlocked
    }

    pub fn new(
        mint_url: &str,
        unit: &str,
        database_path: PathBuf,
        database_password: String,
    ) -> Result<Self, String> {
        let parsed = url::Url::parse(mint_url).map_err(|_| "CDK lifecycle mint URL is invalid")?;
        let loopback = parsed.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if parsed.scheme() != "http" || !loopback {
            return Err("CDK lifecycle mint must be loopback HTTP".to_owned());
        }
        if parsed.username() != ""
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("CDK lifecycle mint URL is invalid".to_owned());
        }
        if database_password.len() < 32 {
            return Err("CDK lifecycle database key is invalid".to_owned());
        }
        let unit = CurrencyUnit::from_str(unit).map_err(|_| "CDK lifecycle unit is invalid")?;
        Ok(Self {
            mint_url: parsed.to_string().trim_end_matches('/').to_owned(),
            unit,
            database_path,
            database_password,
            wallet: Mutex::new(None),
            reset_previous: Mutex::new(None),
            reset_new_path: Mutex::new(None),
            facade: None,
        })
    }

    pub fn with_facade(
        mint_url: &str,
        unit: &str,
        facade: Arc<dyn NativeCdkFacade>,
    ) -> Result<Self, String> {
        let mut wallet = Self::new(
            mint_url,
            unit,
            PathBuf::new(),
            "injected-native-facade-key-00000000".to_owned(),
        )?;
        wallet.facade = Some(facade);
        Ok(wallet)
    }

    async fn required_wallet(&self) -> Result<Arc<Wallet>, &'static str> {
        self.wallet
            .lock()
            .await
            .clone()
            .ok_or("wallet_not_initialized")
    }

    pub async fn load(&self, seed: &str) -> Result<(), &'static str> {
        self.load_generation(seed, 0).await
    }

    pub async fn load_generation(&self, seed: &str, generation: u64) -> Result<(), &'static str> {
        let path = self.path_for_generation(generation);
        let wallet = self.initialize_at(seed, path).await?;
        *self.wallet.lock().await = Some(wallet);
        Ok(())
    }

    fn path_for_generation(&self, generation: u64) -> PathBuf {
        if generation == 0 {
            self.database_path.clone()
        } else {
            PathBuf::from(format!(
                "{}.generation-{generation}",
                self.database_path.display()
            ))
        }
    }

    async fn initialize_at(
        &self,
        seed: &str,
        database_path: PathBuf,
    ) -> Result<Arc<Wallet>, &'static str> {
        if seed.is_empty() {
            return Err("invalid_seed");
        }
        let mut material = b"cashu-fault-lab/cdk-lifecycle-wallet-seed-v1".to_vec();
        material.push(0);
        material.extend_from_slice(seed.as_bytes());
        let wallet_seed = sha512::Hash::hash(&material).to_byte_array();
        let database =
            cdk_sqlite::WalletSqliteDatabase::new((database_path, self.database_password.clone()))
                .await
                .map_err(|_| "wallet_database_initialization_failed")?;
        let wallet = Arc::new(
            Wallet::new(
                &self.mint_url,
                self.unit.clone(),
                Arc::new(database),
                wallet_seed,
                None,
            )
            .map_err(|_| "wallet_initialization_failed")?,
        );
        wallet
            .recover_incomplete_sagas()
            .await
            .map_err(|_| "wallet_saga_recovery_failed")?;
        Ok(wallet)
    }

    fn matching_request(&self, request: &LifecycleInput) -> bool {
        request.mint.trim_end_matches('/') == self.mint_url && request.unit == self.unit.to_string()
    }

    async fn prepare_swap_plan(
        &self,
        wallet: &Wallet,
        request: &LifecycleInput,
    ) -> Result<Vec<u8>, LifecycleExecution> {
        let amount = request
            .amount
            .ok_or_else(|| LifecycleExecution::failed_definitive("invalid_amount"))?;
        let proofs = wallet
            .get_unspent_proofs()
            .await
            .map_err(|_| LifecycleExecution::recovery_blocked("wallet_proof_query_failed"))?;
        let selected = select_exact_proofs(proofs, amount)
            .ok_or_else(|| LifecycleExecution::failed_definitive("exact_swap_plan_unavailable"))?;
        serde_json::to_vec(&NativePreparedPlan::Swap {
            amount,
            proofs: selected,
        })
        .map_err(|_| LifecycleExecution::recovery_blocked("swap_plan_encoding_failed"))
    }

    async fn prepare_send_plan(
        &self,
        wallet: &Wallet,
        request: &LifecycleInput,
    ) -> Result<Vec<u8>, LifecycleExecution> {
        let amount = request
            .amount
            .ok_or_else(|| LifecycleExecution::failed_definitive("invalid_amount"))?;
        let recipient = request
            .recipient
            .clone()
            .ok_or_else(|| LifecycleExecution::failed_definitive("recipient_missing"))?;
        let options = SendOptions {
            send_kind: SendKind::OfflineExact,
            ..Default::default()
        };
        let prepared = wallet
            .prepare_send(Amount::from(amount), options)
            .await
            .map_err(|_| LifecycleExecution::failed_definitive("exact_send_plan_unavailable"))?;
        if !prepared.proofs_to_swap().is_empty() {
            let _ = prepared.cancel().await;
            return Err(LifecycleExecution::recovery_blocked(
                "exact_send_plan_unavailable",
            ));
        }
        let token = Token::new(
            self.mint_url
                .parse()
                .map_err(|_| LifecycleExecution::recovery_blocked("send_plan_encoding_failed"))?,
            prepared.proofs_to_send().clone(),
            None,
            self.unit.clone(),
        )
        .to_string();
        serde_json::to_vec(&NativePreparedPlan::Send {
            amount,
            recipient,
            operation_id: prepared.operation_id().to_string(),
            proofs_to_swap: prepared.proofs_to_swap().clone(),
            proofs_to_send: prepared.proofs_to_send().clone(),
            swap_fee: prepared.swap_fee().to_u64(),
            send_fee: prepared.send_fee().to_u64(),
            token,
        })
        .map_err(|_| LifecycleExecution::recovery_blocked("send_plan_encoding_failed"))
    }

    async fn execute_native_plan(
        &self,
        wallet: &Wallet,
        request: &LifecycleInput,
        material: Option<&[u8]>,
    ) -> LifecycleExecution {
        let Some(material) = material else {
            return LifecycleExecution::recovery_blocked("operation_plan_unavailable");
        };
        let plan: NativePreparedPlan = match serde_json::from_slice(material) {
            Ok(plan) => plan,
            Err(_) => return LifecycleExecution::recovery_blocked("operation_plan_invalid"),
        };
        match (request.kind, plan) {
            (LifecycleKind::Swap, NativePreparedPlan::Swap { amount, proofs })
                if request.amount == Some(amount) =>
            {
                match wallet
                    .swap(None, SplitTarget::default(), proofs, None, false, false)
                    .await
                {
                    Ok(None) => LifecycleExecution::succeeded(Some(amount), "swap_observed")
                        .with_private_material(material.to_vec()),
                    Ok(Some(_)) => LifecycleExecution::recovery_blocked("swap_plan_conflict")
                        .with_private_material(material.to_vec()),
                    Err(_) => LifecycleExecution::ambiguous("swap_response_ambiguous")
                        .with_private_material(material.to_vec()),
                }
            }
            (
                LifecycleKind::Send,
                NativePreparedPlan::Send {
                    amount,
                    recipient,
                    operation_id,
                    proofs_to_swap,
                    proofs_to_send,
                    swap_fee,
                    send_fee,
                    token,
                },
            ) if request.amount == Some(amount)
                && request.recipient.as_deref() == Some(recipient.as_str()) =>
            {
                let operation_id = match operation_id.parse() {
                    Ok(operation_id) => operation_id,
                    Err(_) => {
                        return LifecycleExecution::recovery_blocked("send_plan_invalid")
                            .with_private_material(material.to_vec());
                    }
                };
                let options = SendOptions {
                    send_kind: SendKind::OfflineExact,
                    ..Default::default()
                };
                match wallet
                    .confirm_send(
                        operation_id,
                        Amount::from(amount),
                        options,
                        proofs_to_swap,
                        proofs_to_send,
                        Amount::from(swap_fee),
                        Amount::from(send_fee),
                        None,
                    )
                    .await
                {
                    Ok(observed) if observed.to_string() == token => {
                        LifecycleExecution::send_succeeded(amount, &recipient, &token)
                            .with_private_material(material.to_vec())
                    }
                    Ok(_) => LifecycleExecution::recovery_blocked("send_token_conflict")
                        .with_private_material(material.to_vec()),
                    Err(_) => LifecycleExecution::ambiguous("send_response_ambiguous")
                        .with_private_material(material.to_vec()),
                }
            }
            _ => LifecycleExecution::recovery_blocked("operation_plan_conflict")
                .with_private_material(material.to_vec()),
        }
    }

    async fn recover_native_plan(
        &self,
        wallet: &Wallet,
        request: &LifecycleInput,
        material: Option<&[u8]>,
    ) -> LifecycleExecution {
        let Some(material) = material else {
            return LifecycleExecution::recovery_blocked("operation_plan_unavailable");
        };
        let plan: NativePreparedPlan = match serde_json::from_slice(material) {
            Ok(plan) => plan,
            Err(_) => return LifecycleExecution::recovery_blocked("operation_plan_invalid"),
        };
        match plan {
            NativePreparedPlan::Swap { amount, proofs }
                if request.kind == LifecycleKind::Swap && request.amount == Some(amount) =>
            {
                if wallet.recover_incomplete_sagas().await.is_err() {
                    return LifecycleExecution::recovery_blocked("wallet_saga_recovery_failed")
                        .with_private_material(material.to_vec());
                }
                match wallet.check_proofs_spent(proofs).await {
                    Ok(states) if states.iter().all(|proof| proof.state == State::Spent) => {
                        LifecycleExecution::succeeded(Some(amount), "swap_reconciled")
                            .with_private_material(material.to_vec())
                    }
                    Ok(states) if states.iter().all(|proof| proof.state == State::Unspent) => {
                        LifecycleExecution::failed_definitive("swap_inputs_unspent")
                            .with_private_material(material.to_vec())
                    }
                    Ok(_) => LifecycleExecution::recovery_blocked("swap_input_state_conflict")
                        .with_private_material(material.to_vec()),
                    Err(_) => LifecycleExecution::recovery_blocked("swap_input_state_unavailable")
                        .with_private_material(material.to_vec()),
                }
            }
            NativePreparedPlan::Send {
                amount,
                recipient,
                proofs_to_send,
                token,
                ..
            } if request.kind == LifecycleKind::Send
                && request.amount == Some(amount)
                && request.recipient.as_deref() == Some(recipient.as_str()) =>
            {
                let planned_ys: std::collections::HashSet<_> = proofs_to_send
                    .iter()
                    .filter_map(|proof| proof.y().ok())
                    .map(|y| y.to_string())
                    .collect();
                let correlated = wallet
                    .get_proofs_by_states(vec![State::Reserved, State::PendingSpent, State::Spent])
                    .await
                    .map(|proofs| {
                        proofs
                            .iter()
                            .filter_map(|proof| proof.y().ok())
                            .map(|y| y.to_string())
                            .collect::<std::collections::HashSet<_>>()
                    });
                match correlated {
                    Ok(observed)
                        if planned_ys.len() == proofs_to_send.len()
                            && planned_ys.iter().all(|y| observed.contains(y)) =>
                    {
                        LifecycleExecution::send_succeeded(amount, &recipient, &token)
                            .with_private_material(material.to_vec())
                    }
                    Ok(_) => LifecycleExecution::recovery_blocked("send_state_unbound")
                        .with_private_material(material.to_vec()),
                    Err(_) => LifecycleExecution::recovery_blocked("send_state_unavailable")
                        .with_private_material(material.to_vec()),
                }
            }
            _ => LifecycleExecution::recovery_blocked("operation_plan_conflict")
                .with_private_material(material.to_vec()),
        }
    }

    async fn execute_mint(&self, wallet: &Wallet, request: &LifecycleInput) -> LifecycleExecution {
        let Some(amount) = request.amount else {
            return LifecycleExecution::failed_definitive("invalid_amount");
        };
        let quote = match wallet
            .mint_quote(
                PaymentMethod::BOLT11,
                Some(Amount::from(amount)),
                None,
                None,
            )
            .await
        {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::ambiguous("mint_quote_dependency_error"),
        };
        let quote_id = quote.id.as_bytes().to_vec();
        if quote.state != MintQuoteState::Paid {
            return LifecycleExecution::ambiguous("mint_quote_pending")
                .with_private_material(quote_id);
        }
        match wallet.mint(&quote.id, SplitTarget::default(), None).await {
            Ok(_) => LifecycleExecution::succeeded(Some(amount), "mint_observed")
                .with_private_material(quote_id),
            Err(_) => LifecycleExecution::ambiguous("mint_response_ambiguous")
                .with_private_material(quote_id),
        }
    }

    async fn recover_mint(
        &self,
        wallet: &Wallet,
        request: &LifecycleInput,
        material: Option<&[u8]>,
    ) -> LifecycleExecution {
        let Some(quote_id) = material.and_then(|bytes| std::str::from_utf8(bytes).ok()) else {
            return LifecycleExecution::recovery_blocked("mint_quote_identity_unavailable");
        };
        let quote = match wallet
            .fetch_mint_quote(quote_id, Some(PaymentMethod::BOLT11))
            .await
        {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::recovery_blocked("mint_quote_state_unavailable"),
        };
        match quote.state {
            MintQuoteState::Issued => {
                LifecycleExecution::succeeded(request.amount, "mint_reconciled")
                    .with_private_material(quote_id.as_bytes().to_vec())
            }
            MintQuoteState::Paid => match wallet.mint(quote_id, SplitTarget::default(), None).await
            {
                Ok(_) => LifecycleExecution::succeeded(request.amount, "mint_reconciled")
                    .with_private_material(quote_id.as_bytes().to_vec()),
                Err(_) => LifecycleExecution::recovery_blocked("mint_restore_unavailable")
                    .with_private_material(quote_id.as_bytes().to_vec()),
            },
            MintQuoteState::Unpaid => LifecycleExecution::failed_definitive("mint_quote_unpaid")
                .with_private_material(quote_id.as_bytes().to_vec()),
        }
    }

    async fn execute_melt(&self, wallet: &Wallet, request: &LifecycleInput) -> LifecycleExecution {
        let Some(invoice) = request.secret.as_deref() else {
            return LifecycleExecution::failed_definitive("invoice_missing");
        };
        let quote = match wallet
            .melt_quote(PaymentMethod::BOLT11, invoice, None, None)
            .await
        {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::failed_definitive("melt_quote_rejected"),
        };
        let quote_id = quote.id.as_bytes().to_vec();
        let prepared = match wallet.prepare_melt(&quote.id, HashMap::new()).await {
            Ok(prepared) => prepared,
            Err(_) => return LifecycleExecution::failed_definitive("melt_prepare_failed"),
        };
        let fee_reserve = quote.fee_reserve.to_u64();
        if request.prefer_async == Some(true) {
            return match prepared.confirm_prefer_async().await {
                Ok(MeltOutcome::Paid(result)) if result.state() == MeltQuoteState::Paid => {
                    let change = result
                        .change()
                        .and_then(|proofs| proofs.total_amount().ok())
                        .map_or(0, |amount| amount.to_u64());
                    LifecycleExecution::succeeded(Some(result.amount().to_u64()), "melt_observed")
                        .with_fees(0, fee_reserve, result.fee_paid().to_u64(), change)
                        .with_private_material(quote_id)
                }
                Ok(MeltOutcome::Paid(_)) | Ok(MeltOutcome::Pending(_)) => {
                    LifecycleExecution::ambiguous("melt_pending").with_private_material(quote_id)
                }
                Err(_) => LifecycleExecution::ambiguous("melt_response_ambiguous")
                    .with_private_material(quote_id),
            };
        }
        match prepared.confirm().await {
            Ok(result) if result.state() == MeltQuoteState::Paid => {
                let change = result
                    .change()
                    .and_then(|proofs| proofs.total_amount().ok())
                    .map_or(0, |amount| amount.to_u64());
                LifecycleExecution::succeeded(Some(result.amount().to_u64()), "melt_observed")
                    .with_fees(0, fee_reserve, result.fee_paid().to_u64(), change)
                    .with_private_material(quote_id)
            }
            Ok(_) => LifecycleExecution::ambiguous("melt_pending").with_private_material(quote_id),
            Err(_) => LifecycleExecution::ambiguous("melt_response_ambiguous")
                .with_private_material(quote_id),
        }
    }

    async fn recover_melt(&self, wallet: &Wallet, material: Option<&[u8]>) -> LifecycleExecution {
        let Some(quote_id) = material.and_then(|bytes| std::str::from_utf8(bytes).ok()) else {
            return LifecycleExecution::recovery_blocked("melt_quote_identity_unavailable");
        };
        let quote = match wallet.check_melt_quote_status(quote_id).await {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::recovery_blocked("melt_quote_state_unavailable"),
        };
        match quote.state {
            MeltQuoteState::Paid => LifecycleExecution::melt_recovered(quote.fee_reserve.to_u64())
                .with_private_material(quote_id.as_bytes().to_vec()),
            MeltQuoteState::Unpaid | MeltQuoteState::Failed => {
                LifecycleExecution::failed_definitive("melt_quote_unpaid")
                    .with_private_material(quote_id.as_bytes().to_vec())
            }
            _ => LifecycleExecution::recovery_blocked("melt_quote_not_terminal")
                .with_private_material(quote_id.as_bytes().to_vec()),
        }
    }
}

#[async_trait]
impl LifecycleWalletPort for NativeCdkLifecycleWallet {
    async fn reset(&self, seed: &str) -> Result<(), &'static str> {
        if let Some(facade) = self.facade.as_ref() {
            return facade.reset(seed).await.map_err(|_| "native_reset_failed");
        }
        Err("reset_generation_required")
    }

    async fn reset_generation(&self, seed: &str, generation: u64) -> Result<(), &'static str> {
        if let Some(facade) = self.facade.as_ref() {
            return facade.reset(seed).await.map_err(|_| "native_reset_failed");
        }
        let path = self.path_for_generation(generation);
        remove_wallet_files(&path)?;
        let next = self.initialize_at(seed, path.clone()).await?;
        let previous = self.wallet.lock().await.replace(next);
        *self.reset_previous.lock().await = previous;
        *self.reset_new_path.lock().await = Some(path);
        Ok(())
    }

    async fn rollback_reset(&self) -> Result<(), &'static str> {
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .rollback_reset()
                .await
                .map_err(|_| "native_reset_rollback_failed");
        }
        let previous = self.reset_previous.lock().await.take();
        let new_path = self.reset_new_path.lock().await.take();
        *self.wallet.lock().await = previous;
        if let Some(path) = new_path {
            remove_wallet_files(&path)?;
        }
        Ok(())
    }

    async fn commit_reset(&self) -> Result<(), &'static str> {
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .commit_reset()
                .await
                .map_err(|_| "native_reset_commit_failed");
        }
        self.reset_previous.lock().await.take();
        self.reset_new_path.lock().await.take();
        Ok(())
    }

    async fn prepare(
        &self,
        request: &LifecycleInput,
    ) -> Result<Option<Vec<u8>>, LifecycleExecution> {
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .prepare(request)
                .await
                .map_err(|_| LifecycleExecution::recovery_blocked("native_prepare_failed"));
        }
        if !self.matching_request(request) {
            return Err(LifecycleExecution::failed_definitive(
                "mint_or_unit_not_configured",
            ));
        }
        let wallet = self
            .required_wallet()
            .await
            .map_err(LifecycleExecution::recovery_blocked)?;
        match request.kind {
            LifecycleKind::Swap => self.prepare_swap_plan(&wallet, request).await.map(Some),
            LifecycleKind::Send => self.prepare_send_plan(&wallet, request).await.map(Some),
            _ => Ok(None),
        }
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        if !Self::operation_bound(request.kind) {
            return LifecycleExecution::recovery_blocked("operation_not_applicable");
        }
        if !self.matching_request(request) {
            return LifecycleExecution::failed_definitive("mint_or_unit_not_configured");
        }
        if self.facade.is_some() {
            return match self.prepare(request).await {
                Ok(material) => self.execute_prepared(request, material.as_deref()).await,
                Err(execution) => execution,
            };
        }
        let wallet = match self.required_wallet().await {
            Ok(wallet) => wallet,
            Err(code) => return LifecycleExecution::recovery_blocked(code),
        };
        if matches!(request.kind, LifecycleKind::Swap | LifecycleKind::Send) {
            return match self.prepare(request).await {
                Ok(material) => {
                    self.execute_native_plan(&wallet, request, material.as_deref())
                        .await
                }
                Err(execution) => execution,
            };
        }
        match request.kind {
            LifecycleKind::Mint => self.execute_mint(&wallet, request).await,
            LifecycleKind::Swap | LifecycleKind::Send => unreachable!("handled above"),
            LifecycleKind::Reconcile => {
                LifecycleExecution::recovery_blocked("reconcile_requires_engine")
            }
            LifecycleKind::Receive => {
                let Some(token) = request.secret.as_deref() else {
                    return LifecycleExecution::failed_definitive("token_missing");
                };
                match wallet.receive(token, ReceiveOptions::default()).await {
                    Ok(amount) => {
                        LifecycleExecution::succeeded(Some(amount.to_u64()), "receive_observed")
                    }
                    Err(_) => LifecycleExecution::ambiguous("receive_response_ambiguous"),
                }
            }
            LifecycleKind::Melt => self.execute_melt(&wallet, request).await,
            LifecycleKind::Restore => match wallet.restore().await {
                Ok(restored) => LifecycleExecution::succeeded(
                    Some(restored.unspent.to_u64()),
                    "restore_observed",
                ),
                Err(_) => LifecycleExecution::recovery_blocked("nut09_restore_unavailable"),
            },
        }
    }

    async fn execute_prepared(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .execute(request, private_material)
                .await
                .unwrap_or_else(|_| LifecycleExecution::ambiguous("native_dependency_error"));
        }
        if matches!(request.kind, LifecycleKind::Swap | LifecycleKind::Send) {
            let wallet = match self.required_wallet().await {
                Ok(wallet) => wallet,
                Err(code) => return LifecycleExecution::recovery_blocked(code),
            };
            self.execute_native_plan(&wallet, request, private_material)
                .await
        } else {
            self.execute(request).await
        }
    }

    async fn recover(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .recover(request, private_material)
                .await
                .unwrap_or_else(|_| {
                    LifecycleExecution::recovery_blocked("native_recovery_unavailable")
                });
        }
        let wallet = match self.required_wallet().await {
            Ok(wallet) => wallet,
            Err(code) => return LifecycleExecution::recovery_blocked(code),
        };
        if matches!(request.kind, LifecycleKind::Swap | LifecycleKind::Send) {
            return self
                .recover_native_plan(&wallet, request, private_material)
                .await;
        }
        match wallet.recover_incomplete_sagas().await {
            Ok(_) => {}
            Err(_) => {
                return LifecycleExecution::recovery_blocked("wallet_saga_recovery_failed");
            }
        }
        match request.kind {
            LifecycleKind::Mint => self.recover_mint(&wallet, request, private_material).await,
            LifecycleKind::Melt => self.recover_melt(&wallet, private_material).await,
            LifecycleKind::Restore => self.execute(request).await,
            LifecycleKind::Receive => {
                let _ = Self::aggregate_recovery_phase(request.kind);
                LifecycleExecution::recovery_blocked("operation_bound_recovery_unavailable")
            }
            LifecycleKind::Swap | LifecycleKind::Send => unreachable!("handled above"),
            LifecycleKind::Reconcile => {
                LifecycleExecution::recovery_blocked("reconcile_requires_engine")
            }
        }
    }

    async fn wallet(&self) -> Result<LifecycleWalletView, &'static str> {
        if let Some(facade) = self.facade.as_ref() {
            return facade.wallet().await.map_err(|_| "wallet_query_failed");
        }
        let wallet = self.required_wallet().await?;
        let available = wallet
            .total_balance()
            .await
            .map_err(|_| "wallet_balance_failed")?;
        let reserved = wallet
            .total_reserved_balance()
            .await
            .map_err(|_| "wallet_balance_failed")?;
        let pending = wallet
            .total_pending_balance()
            .await
            .map_err(|_| "wallet_balance_failed")?;
        let mut proofs = Vec::new();
        for (state, public_state) in [
            (State::Unspent, "UNSPENT"),
            (State::Pending, "PENDING"),
            (State::Reserved, "PENDING"),
            (State::PendingSpent, "PENDING"),
        ] {
            let values = wallet
                .get_proofs_by_states(vec![state])
                .await
                .map_err(|_| "wallet_proof_query_failed")?;
            for proof in values {
                let y = proof.y().map_err(|_| "wallet_proof_hash_failed")?;
                proofs.push(LifecycleProofView {
                    proof_id: hash_parts(
                        b"cashu-fault-lab/cdk-lifecycle-proof-v1",
                        &[y.to_string().as_bytes()],
                    ),
                    state: public_state.to_owned(),
                });
            }
        }
        proofs.sort_by(|left, right| left.proof_id.cmp(&right.proof_id));
        Ok(LifecycleWalletView {
            wallet_id: "cdk".to_owned(),
            mint: self.mint_url.clone(),
            unit: self.unit.to_string(),
            balances: LifecycleBalances {
                available: available.to_u64(),
                reserved: reserved.to_u64(),
                recoverable: pending.to_u64(),
            },
            proofs,
        })
    }

    async fn capabilities(&self) -> Result<LifecycleRuntimeCapabilities, &'static str> {
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .capabilities()
                .await
                .map_err(|_| "mint_capabilities_unavailable");
        }
        let wallet = self.required_wallet().await?;
        let info = wallet
            .load_mint_info()
            .await
            .map_err(|_| "mint_capabilities_unavailable")?;
        let supports_mint = !info.nuts.nut04.disabled
            && info
                .nuts
                .nut04
                .get_settings(&self.unit, &PaymentMethod::BOLT11)
                .is_some();
        let supports_melt = !info.nuts.nut05.disabled
            && info
                .nuts
                .nut05
                .get_settings(&self.unit, &PaymentMethod::BOLT11)
                .is_some();
        let supports_proof_state = info.nuts.nut07.supported;
        let supports_fee_return = info.nuts.nut08.supported;
        let supports_restore = info.nuts.nut09.supported;
        let supports_replay = !info.nuts.nut19.cached_endpoints.is_empty();
        let supports_quote_locking = info.nuts.nut20.supported;
        let mut operations = vec!["send", "receive", "reconcile"];
        if supports_proof_state {
            operations.push("swap");
        }
        if supports_mint {
            operations.push("mint");
        }
        if supports_melt {
            operations.push("melt");
        }
        if supports_restore {
            operations.push("restore");
        }
        let mut nuts = vec![3];
        for (supported, nut) in [
            (supports_mint, 4),
            (supports_melt, 5),
            (supports_proof_state, 7),
            (supports_fee_return, 8),
            (supports_restore, 9),
            (supports_restore, 13),
            (supports_replay, 19),
            (supports_quote_locking, 20),
            (supports_mint || supports_melt, 23),
        ] {
            if supported {
                nuts.push(nut);
            }
        }
        let recovery = operation_bound_recovery_mechanisms(
            &operations,
            supports_mint || supports_melt,
            supports_proof_state,
            supports_restore,
            supports_replay,
        );
        Ok(LifecycleRuntimeCapabilities {
            operations,
            nuts,
            recovery,
        })
    }
}
