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

use crate::{lifecycle_store::LifecycleStore, lightning_probe::CdkLightningSettlementProbe};

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

    pub fn melt_recovered(amount: u64, fee_reserve: u64, actual_fee: u64, change: u64) -> Self {
        Self::succeeded(Some(amount), "melt_settlement_verified").with_fees(
            0,
            fee_reserve,
            actual_fee,
            change,
        )
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

    pub fn with_input_fee(mut self, input_fee: u64) -> Self {
        self.input_fee = Some(input_fee);
        self
    }

    fn submitted_failure_requires_reconcile(mut self) -> Self {
        if matches!(
            self.phase,
            LifecyclePhase::FailedDefinitive | LifecyclePhase::RecoveryBlocked
        ) {
            self.phase = LifecyclePhase::Ambiguous;
            self.evidence_code = Some("submitted_failure_requires_reconcile");
            self.event = "submitted_failure_requires_reconcile".to_owned();
            self.amount = None;
            self.input_fee = None;
            self.fee_reserve = None;
            self.actual_fee = None;
            self.change = None;
            self.send_handoff = None;
        }
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
    async fn post_commit_reset_cleanup(&self) -> Result<(), &'static str> {
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
        if seed.is_empty() || seed.chars().count() > 256 {
            return Err("lifecycle seed is invalid".to_owned());
        }
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
                Ok(()) => match self.wallet.commit_reset().await {
                    Ok(()) => {
                        let _ = self.wallet.post_commit_reset_cleanup().await;
                        Ok(())
                    }
                    Err(error) => Err(error.to_owned()),
                },
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
        if input.kind != LifecycleKind::Reconcile
            && !self.store.try_claim_wallet_mutation(operation_id, token)?
        {
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
        match self.reconcile_dependency_cycle(input) {
            Ok(true) => {
                return LifecycleExecution::failed_definitive("reconcile_dependency_cycle");
            }
            Ok(false) => {}
            Err(code) => return LifecycleExecution::recovery_blocked(code),
        }
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

    fn reconcile_dependency_cycle(&self, input: &LifecycleInput) -> Result<bool, &'static str> {
        let Some(mut cursor) = input.target_operation_id.clone() else {
            return Ok(false);
        };
        let mut visited = std::collections::HashSet::from([input.operation_id.clone()]);
        for _ in 0..10_000 {
            if !visited.insert(cursor.clone()) {
                return Ok(true);
            }
            let Ok(target) = self.store.input(&cursor) else {
                return Ok(false);
            };
            if target.kind != LifecycleKind::Reconcile {
                return Ok(false);
            }
            let Some(next) = target.target_operation_id else {
                return Ok(false);
            };
            cursor = next;
        }
        Err("reconcile_dependency_bound_exceeded")
    }

    fn finish_execution(
        &self,
        mut operation: LifecycleOperation,
        execution: LifecycleExecution,
        token: u64,
    ) -> Result<LifecycleOperation, String> {
        let execution = if operation.phase == LifecyclePhase::Submitted {
            execution.submitted_failure_requires_reconcile()
        } else {
            execution
        };
        operation.phase = execution.phase;
        operation.evidence_code = execution.evidence_code.map(str::to_owned);
        operation.amount = execution.amount.or(operation.amount);
        operation.input_fee = execution.input_fee;
        operation.fee_reserve = execution.fee_reserve;
        operation.actual_fee = execution.actual_fee;
        operation.change = execution.change;
        if operation.kind == LifecycleKind::Mint
            && let Some(quote_id) = execution.private_material.as_deref()
        {
            operation.quote_hash = Some(hash_parts(
                b"cashu-fault-lab/cdk-lifecycle-mint-quote-v1",
                &[quote_id],
            ));
        }
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
                .is_none_or(|secret| secret.is_empty() || secret.chars().count() > 262_144)
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
                .is_none_or(|secret| secret.is_empty() || secret.chars().count() > 16_384)
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
    proofs: Vec<(String, u64)>,
    amount: u64,
) -> Option<Vec<String>> {
    deterministic_fee_aware_exact_amount_plan(
        proofs
            .into_iter()
            .map(|(id, amount)| FeeAwareProof {
                id,
                amount,
                input_fee_ppk: 0,
            })
            .collect(),
        amount,
    )
    .ok()
    .flatten()
    .map(|plan| plan.proof_ids)
}

const MAX_SWAP_PLAN_PROOFS: usize = 10_000;
const MAX_SWAP_PLAN_STATES: usize = 250_000;
const MAX_SWAP_PLAN_WORK: usize = 1_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeAwareProof {
    pub id: String,
    pub amount: u64,
    pub input_fee_ppk: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeAwareExactAmountPlan {
    pub proof_ids: Vec<String>,
    pub gross_input: u64,
    pub input_fee: u64,
    pub net_output: u64,
}

/// Finds an exact NUT-02 plan within the lifecycle proof and search-state bounds.
///
/// The requested amount is the net value returned by the swap. A valid plan therefore satisfies
/// `gross_input == net_output + ceil(sum(input_fee_ppk) / 1000)`.
pub fn deterministic_fee_aware_exact_amount_plan(
    proofs: Vec<FeeAwareProof>,
    net_output: u64,
) -> Result<Option<FeeAwareExactAmountPlan>, &'static str> {
    fee_aware_exact_amount_plan_with_limits(
        proofs,
        net_output,
        MAX_SWAP_PLAN_WORK,
        MAX_SWAP_PLAN_STATES,
    )
}

#[derive(Clone, Copy)]
struct SwapPlanNode {
    previous: Option<usize>,
    proof_index: usize,
}

pub fn fee_aware_exact_amount_plan_with_limits(
    mut proofs: Vec<FeeAwareProof>,
    net_output: u64,
    maximum_work: usize,
    maximum_states: usize,
) -> Result<Option<FeeAwareExactAmountPlan>, &'static str> {
    if proofs.len() > MAX_SWAP_PLAN_PROOFS {
        return Err("wallet_proof_limit_exceeded");
    }
    proofs.sort_by(|left, right| {
        right
            .amount
            .cmp(&left.amount)
            .then_with(|| left.id.cmp(&right.id))
    });
    let maximum_fee_ppk = proofs
        .iter()
        .try_fold(0_u64, |sum, proof| sum.checked_add(proof.input_fee_ppk));
    let Some(maximum_fee_ppk) = maximum_fee_ppk else {
        return Err("swap_plan_value_overflow");
    };
    let maximum_fee = maximum_fee_ppk.saturating_add(999) / 1_000;
    let maximum_gross = net_output
        .checked_add(maximum_fee)
        .ok_or("swap_plan_value_overflow")?;
    let mut plans = std::collections::BTreeMap::from([((0_u64, 0_u64), None)]);
    let mut nodes = Vec::<SwapPlanNode>::new();
    let mut work = 0_usize;

    for (proof_index, proof) in proofs.iter().enumerate() {
        let prior = plans
            .iter()
            .map(|(state, node)| (*state, *node))
            .collect::<Vec<_>>();
        for ((gross_input, fee_ppk), previous) in prior {
            work = work.checked_add(1).ok_or("swap_plan_work_bound_exceeded")?;
            if work > maximum_work {
                return Err("swap_plan_work_bound_exceeded");
            }
            let Some(next_gross) = gross_input.checked_add(proof.amount) else {
                continue;
            };
            let Some(next_fee_ppk) = fee_ppk.checked_add(proof.input_fee_ppk) else {
                continue;
            };
            if next_gross > maximum_gross || plans.contains_key(&(next_gross, next_fee_ppk)) {
                continue;
            }
            let node = nodes.len();
            nodes.push(SwapPlanNode {
                previous,
                proof_index,
            });
            let input_fee = next_fee_ppk.saturating_add(999) / 1_000;
            if next_gross == net_output.saturating_add(input_fee) {
                let mut proof_ids = Vec::new();
                let mut cursor = Some(node);
                while let Some(index) = cursor {
                    let selected = nodes[index];
                    proof_ids.push(proofs[selected.proof_index].id.clone());
                    cursor = selected.previous;
                }
                proof_ids.reverse();
                return Ok(Some(FeeAwareExactAmountPlan {
                    proof_ids,
                    gross_input: next_gross,
                    input_fee,
                    net_output,
                }));
            }
            plans.insert((next_gross, next_fee_ppk), Some(node));
            if plans.len() > maximum_states {
                return Err("swap_plan_search_bound_exceeded");
            }
        }
    }

    Ok(None)
}

pub fn exact_nut07_input_state(
    expected_ys: &[String],
    observed: &[(String, State)],
) -> Result<State, &'static str> {
    if expected_ys.is_empty() || observed.len() != expected_ys.len() {
        return Err("swap_input_state_unbound");
    }
    let expected = expected_ys
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let observed_ys = observed
        .iter()
        .map(|(y, _)| y.as_str())
        .collect::<std::collections::HashSet<_>>();
    if expected.len() != expected_ys.len()
        || observed_ys.len() != observed.len()
        || expected != observed_ys
    {
        return Err("swap_input_state_unbound");
    }
    let state = observed[0].1;
    if !matches!(state, State::Spent | State::Unspent)
        || observed.iter().any(|(_, observed)| *observed != state)
    {
        return Err("swap_input_state_conflict");
    }
    Ok(state)
}

pub const fn swap_recovery_report_is_complete(skipped: usize, failed: usize) -> bool {
    skipped == 0 && failed == 0
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SendRecoveryDisposition {
    ReplayConfirmation,
    Confirmed,
    Blocked,
}

pub fn send_recovery_disposition(
    expected_ys: &[String],
    observed: &[(String, State)],
) -> SendRecoveryDisposition {
    if expected_ys.is_empty() || observed.len() != expected_ys.len() {
        return SendRecoveryDisposition::Blocked;
    }
    let expected = expected_ys
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let observed_ys = observed
        .iter()
        .map(|(y, _)| y.as_str())
        .collect::<std::collections::HashSet<_>>();
    if expected.len() != expected_ys.len()
        || observed_ys.len() != observed.len()
        || expected != observed_ys
    {
        return SendRecoveryDisposition::Blocked;
    }
    let state = observed[0].1;
    if observed.iter().any(|(_, observed)| *observed != state) {
        return SendRecoveryDisposition::Blocked;
    }
    match state {
        State::Reserved => SendRecoveryDisposition::ReplayConfirmation,
        State::PendingSpent | State::Spent => SendRecoveryDisposition::Confirmed,
        _ => SendRecoveryDisposition::Blocked,
    }
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

pub fn supports_nut19_swap_replay(endpoints: &[cdk::nuts::nut19::CachedEndpoint]) -> bool {
    endpoints.iter().any(|endpoint| {
        endpoint.method == cdk::nuts::nut19::Method::Post
            && endpoint.path == cdk::nuts::nut19::Path::Swap
    })
}

async fn select_exact_proofs(
    wallet: &Wallet,
    proofs: Proofs,
    net_output: u64,
) -> Result<Option<(Proofs, FeeAwareExactAmountPlan)>, &'static str> {
    let mut by_id = HashMap::new();
    let mut summaries = Vec::with_capacity(proofs.len());
    for proof in proofs {
        let id = proof
            .y()
            .map_err(|_| "wallet_proof_identifier_invalid")?
            .to_string();
        let input_fee_ppk = wallet
            .get_keyset_fees_by_id(proof.keyset_id)
            .await
            .map_err(|_| "wallet_keyset_fee_unavailable")?;
        summaries.push(FeeAwareProof {
            id: id.clone(),
            amount: proof.amount.to_u64(),
            input_fee_ppk,
        });
        by_id.insert(id, proof);
    }
    let Some(plan) = deterministic_fee_aware_exact_amount_plan(summaries, net_output)? else {
        return Ok(None);
    };
    let selected = plan
        .proof_ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .collect::<Proofs>();
    if selected.len() != plan.proof_ids.len() {
        return Err("wallet_proof_identifier_conflict");
    }
    Ok(Some((selected, plan)))
}

async fn correlated_swap_outputs(
    wallet: &Wallet,
    prior_unspent_ys: &[String],
    net_output: u64,
) -> Result<Vec<String>, &'static str> {
    let prior = prior_unspent_ys
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    if prior.len() != prior_unspent_ys.len() {
        return Err("swap_output_correlation_invalid");
    }
    let current = wallet
        .get_unspent_proofs()
        .await
        .map_err(|_| "swap_output_state_unavailable")?;
    let mut outputs = Vec::new();
    let mut output_ids = std::collections::HashSet::new();
    let mut observed_output = 0_u64;
    for proof in current {
        let y = proof
            .y()
            .map_err(|_| "swap_output_correlation_invalid")?
            .to_string();
        if prior.contains(y.as_str()) {
            continue;
        }
        if !output_ids.insert(y.clone()) {
            return Err("swap_output_correlation_invalid");
        }
        observed_output = observed_output
            .checked_add(proof.amount.to_u64())
            .ok_or("swap_output_value_overflow")?;
        outputs.push(y);
    }
    if outputs.is_empty() || observed_output != net_output {
        return Err("swap_output_value_conflict");
    }
    outputs.sort();
    Ok(outputs)
}

async fn observed_local_proof_states(
    wallet: &Wallet,
    expected_ys: &[String],
) -> Result<Vec<(String, State)>, &'static str> {
    let expected = expected_ys
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut observed = Vec::new();
    for state in [
        State::Unspent,
        State::Reserved,
        State::PendingSpent,
        State::Spent,
    ] {
        let proofs = wallet
            .get_proofs_by_states(vec![state])
            .await
            .map_err(|_| "send_state_unavailable")?;
        for proof in proofs {
            let y = proof.y().map_err(|_| "send_state_unavailable")?.to_string();
            if expected.contains(y.as_str()) {
                observed.push((y, state));
            }
        }
    }
    Ok(observed)
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

pub fn garbage_collect_inactive_wallet_generations(
    database_path: &std::path::Path,
    active_generation: u64,
) -> Result<(), &'static str> {
    let parent = database_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let Some(base_name) = database_path.file_name().and_then(|name| name.to_str()) else {
        return Err("wallet_database_gc_failed");
    };
    let active_name = if active_generation == 0 {
        base_name.to_owned()
    } else {
        format!("{base_name}.generation-{active_generation}")
    };
    let entries = std::fs::read_dir(parent).map_err(|_| "wallet_database_gc_failed")?;
    for entry in entries {
        let entry = entry.map_err(|_| "wallet_database_gc_failed")?;
        let file_type = entry.file_type().map_err(|_| "wallet_database_gc_failed")?;
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let stem = name
            .strip_suffix("-wal")
            .or_else(|| name.strip_suffix("-shm"))
            .unwrap_or(&name);
        let is_generation = stem == base_name
            || stem
                .strip_prefix(&format!("{base_name}.generation-"))
                .is_some_and(|generation| {
                    !generation.is_empty() && generation.bytes().all(|byte| byte.is_ascii_digit())
                });
        if is_generation && stem != active_name {
            std::fs::remove_file(entry.path()).map_err(|_| "wallet_database_gc_failed")?;
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
    reset_generation: Mutex<Option<u64>>,
    facade: Option<Arc<dyn NativeCdkFacade>>,
    settlement_probe: Option<Arc<dyn CdkLightningSettlementProbe>>,
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
        net_output: u64,
        gross_input: u64,
        input_fee: u64,
        proofs: Proofs,
        prior_unspent_ys: Vec<String>,
        #[serde(default)]
        output_ys: Vec<String>,
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

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NativeMeltRecoveryPlan {
    quote_id: String,
    amount: u64,
    fee_reserve: u64,
    balance_before: u64,
    #[serde(default)]
    input_fee: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NativeReceiveRecoveryPlan {
    balance_before: u64,
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

    pub fn receive_recovery_amount(
        balance_before: u64,
        balance_after: u64,
    ) -> Result<u64, &'static str> {
        match balance_after.checked_sub(balance_before) {
            Some(0) => Err("receive_value_unverified"),
            Some(amount) => Ok(amount),
            None => Err("receive_value_mismatch"),
        }
    }

    pub fn melt_recovery_fees(
        balance_before: u64,
        balance_after: u64,
        amount: u64,
        input_fee: u64,
        fee_reserve: u64,
    ) -> Result<(u64, u64), &'static str> {
        let debit = balance_before
            .checked_sub(balance_after)
            .ok_or("melt_balance_increased")?;
        let actual_fee = debit
            .checked_sub(amount)
            .and_then(|value| value.checked_sub(input_fee))
            .ok_or("melt_value_mismatch")?;
        let change = fee_reserve
            .checked_sub(actual_fee)
            .ok_or("melt_fee_exceeds_reserve")?;
        Ok((actual_fee, change))
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
            reset_generation: Mutex::new(None),
            facade: None,
            settlement_probe: None,
        })
    }

    pub fn with_settlement_probe(mut self, probe: Arc<dyn CdkLightningSettlementProbe>) -> Self {
        self.settlement_probe = Some(probe);
        self
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
        let _ = garbage_collect_inactive_wallet_generations(&self.database_path, generation);
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
        let prior_unspent_ys = proofs
            .iter()
            .map(|proof| proof.y().map(|y| y.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| LifecycleExecution::recovery_blocked("wallet_proof_identifier_invalid"))?;
        let (selected, value_plan) = select_exact_proofs(wallet, proofs, amount)
            .await
            .map_err(LifecycleExecution::recovery_blocked)?
            .ok_or_else(|| LifecycleExecution::failed_definitive("exact_swap_plan_unavailable"))?;
        serde_json::to_vec(&NativePreparedPlan::Swap {
            net_output: value_plan.net_output,
            gross_input: value_plan.gross_input,
            input_fee: value_plan.input_fee,
            proofs: selected,
            prior_unspent_ys,
            output_ys: Vec::new(),
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
            (
                LifecycleKind::Swap,
                NativePreparedPlan::Swap {
                    net_output,
                    gross_input,
                    input_fee,
                    proofs,
                    prior_unspent_ys,
                    output_ys: _,
                },
            ) if request.amount == Some(net_output)
                && net_output.checked_add(input_fee) == Some(gross_input)
                && proofs
                    .iter()
                    .try_fold(0_u64, |sum, proof| sum.checked_add(proof.amount.to_u64()))
                    == Some(gross_input) =>
            {
                match wallet.get_proofs_fee(&proofs).await {
                    Ok(fee) if fee.total.to_u64() == input_fee => {}
                    Ok(_) => {
                        return LifecycleExecution::recovery_blocked("swap_input_fee_conflict")
                            .with_private_material(material.to_vec());
                    }
                    Err(_) => {
                        return LifecycleExecution::recovery_blocked("swap_input_fee_unavailable")
                            .with_private_material(material.to_vec());
                    }
                }
                match wallet
                    .swap(
                        None,
                        SplitTarget::default(),
                        proofs.clone(),
                        None,
                        false,
                        false,
                    )
                    .await
                {
                    Ok(None) => {
                        let output_ys =
                            match correlated_swap_outputs(wallet, &prior_unspent_ys, net_output)
                                .await
                            {
                                Ok(output_ys) => output_ys,
                                Err(code) => {
                                    return LifecycleExecution::recovery_blocked(code)
                                        .with_private_material(material.to_vec());
                                }
                            };
                        let material = serde_json::to_vec(&NativePreparedPlan::Swap {
                            net_output,
                            gross_input,
                            input_fee,
                            proofs,
                            prior_unspent_ys,
                            output_ys,
                        })
                        .unwrap_or_else(|_| material.to_vec());
                        LifecycleExecution::succeeded(Some(net_output), "swap_observed")
                            .with_input_fee(input_fee)
                            .with_private_material(material)
                    }
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
            NativePreparedPlan::Swap {
                net_output,
                gross_input,
                input_fee,
                proofs,
                prior_unspent_ys,
                output_ys,
                ..
            } if request.kind == LifecycleKind::Swap
                && request.amount == Some(net_output)
                && net_output.checked_add(input_fee) == Some(gross_input)
                && proofs
                    .iter()
                    .try_fold(0_u64, |sum, proof| sum.checked_add(proof.amount.to_u64()))
                    == Some(gross_input) =>
            {
                match wallet.get_proofs_fee(&proofs).await {
                    Ok(fee) if fee.total.to_u64() == input_fee => {}
                    Ok(_) => {
                        return LifecycleExecution::recovery_blocked("swap_input_fee_conflict")
                            .with_private_material(material.to_vec());
                    }
                    Err(_) => {
                        return LifecycleExecution::recovery_blocked("swap_input_fee_unavailable")
                            .with_private_material(material.to_vec());
                    }
                }
                let report = match wallet.recover_incomplete_sagas().await {
                    Ok(report) => report,
                    Err(_) => {
                        return LifecycleExecution::recovery_blocked("wallet_saga_recovery_failed")
                            .with_private_material(material.to_vec());
                    }
                };
                if !swap_recovery_report_is_complete(report.skipped, report.failed) {
                    return LifecycleExecution::recovery_blocked("wallet_saga_recovery_incomplete")
                        .with_private_material(material.to_vec());
                }
                let expected_ys = match proofs
                    .iter()
                    .map(|proof| proof.y().map(|y| y.to_string()))
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(expected_ys) => expected_ys,
                    Err(_) => {
                        return LifecycleExecution::recovery_blocked(
                            "swap_input_identifier_invalid",
                        )
                        .with_private_material(material.to_vec());
                    }
                };
                let states = match wallet.check_proofs_spent(proofs).await {
                    Ok(states) => states
                        .into_iter()
                        .map(|proof| (proof.y.to_string(), proof.state))
                        .collect::<Vec<_>>(),
                    Err(_) => {
                        return LifecycleExecution::recovery_blocked(
                            "swap_input_state_unavailable",
                        )
                        .with_private_material(material.to_vec());
                    }
                };
                match exact_nut07_input_state(&expected_ys, &states) {
                    Ok(State::Spent) => {
                        let correlated =
                            match correlated_swap_outputs(wallet, &prior_unspent_ys, net_output)
                                .await
                            {
                                Ok(correlated) => correlated,
                                Err(code) => {
                                    return LifecycleExecution::recovery_blocked(code)
                                        .with_private_material(material.to_vec());
                                }
                            };
                        if !output_ys.is_empty() && output_ys != correlated {
                            return LifecycleExecution::recovery_blocked(
                                "swap_output_correlation_conflict",
                            )
                            .with_private_material(material.to_vec());
                        }
                        LifecycleExecution::succeeded(Some(net_output), "swap_reconciled")
                            .with_input_fee(input_fee)
                            .with_private_material(material.to_vec())
                    }
                    Ok(State::Unspent) => {
                        LifecycleExecution::failed_definitive("swap_inputs_unspent")
                            .with_private_material(material.to_vec())
                    }
                    Ok(_) => LifecycleExecution::recovery_blocked("swap_input_state_conflict")
                        .with_private_material(material.to_vec()),
                    Err(code) => LifecycleExecution::recovery_blocked(code)
                        .with_private_material(material.to_vec()),
                }
            }
            NativePreparedPlan::Send {
                amount,
                recipient,
                operation_id,
                proofs_to_swap,
                proofs_to_send,
                swap_fee,
                send_fee,
                token,
            } if request.kind == LifecycleKind::Send
                && request.amount == Some(amount)
                && request.recipient.as_deref() == Some(recipient.as_str()) =>
            {
                let planned_ys = proofs_to_send
                    .iter()
                    .map(|proof| proof.y().map(|y| y.to_string()))
                    .collect::<Result<Vec<_>, _>>();
                let Ok(planned_ys) = planned_ys else {
                    return LifecycleExecution::recovery_blocked("send_state_unbound")
                        .with_private_material(material.to_vec());
                };
                let observed = match observed_local_proof_states(wallet, &planned_ys).await {
                    Ok(observed) => observed,
                    Err(code) => {
                        return LifecycleExecution::recovery_blocked(code)
                            .with_private_material(material.to_vec());
                    }
                };
                match send_recovery_disposition(&planned_ys, &observed) {
                    SendRecoveryDisposition::Confirmed => {
                        LifecycleExecution::send_succeeded(amount, &recipient, &token)
                            .with_private_material(material.to_vec())
                    }
                    SendRecoveryDisposition::ReplayConfirmation => {
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
                            Ok(observed_token) if observed_token.to_string() == token => {
                                let observed =
                                    observed_local_proof_states(wallet, &planned_ys).await;
                                match observed {
                                    Ok(observed)
                                        if send_recovery_disposition(&planned_ys, &observed)
                                            == SendRecoveryDisposition::Confirmed =>
                                    {
                                        LifecycleExecution::send_succeeded(
                                            amount, &recipient, &token,
                                        )
                                        .with_private_material(material.to_vec())
                                    }
                                    _ => LifecycleExecution::recovery_blocked(
                                        "send_confirmation_state_unbound",
                                    )
                                    .with_private_material(material.to_vec()),
                                }
                            }
                            Ok(_) => LifecycleExecution::recovery_blocked("send_token_conflict")
                                .with_private_material(material.to_vec()),
                            Err(_) => LifecycleExecution::recovery_blocked(
                                "send_confirmation_replay_failed",
                            )
                            .with_private_material(material.to_vec()),
                        }
                    }
                    SendRecoveryDisposition::Blocked => {
                        LifecycleExecution::recovery_blocked("send_state_unbound")
                            .with_private_material(material.to_vec())
                    }
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
        let mut quote = match wallet
            .fetch_mint_quote(quote_id, Some(PaymentMethod::BOLT11))
            .await
        {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::recovery_blocked("mint_quote_state_unavailable"),
        };
        // Fake and real Lightning backends can report UNPAID briefly after the quote response.
        // A single check races that transition and leaves an otherwise recoverable mint
        // ambiguous. Poll only the already-persisted quote identity; never create a second quote.
        for _ in 0..80 {
            if quote.state != MintQuoteState::Unpaid {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            quote = match wallet
                .fetch_mint_quote(quote_id, Some(PaymentMethod::BOLT11))
                .await
            {
                Ok(quote) => quote,
                Err(_) => {
                    return LifecycleExecution::recovery_blocked("mint_quote_state_unavailable")
                        .with_private_material(quote_id.as_bytes().to_vec());
                }
            };
        }
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
            // A BOLT11 quote can move from UNPAID to PAID until it expires. Treating the first
            // unpaid poll as definitive races fake and real Lightning backends and can strand a
            // payment that arrives after recovery begins.
            MintQuoteState::Unpaid => LifecycleExecution::ambiguous("mint_quote_pending")
                .with_private_material(quote_id.as_bytes().to_vec()),
        }
    }

    async fn execute_melt(&self, wallet: &Wallet, request: &LifecycleInput) -> LifecycleExecution {
        let Some(invoice) = request.secret.as_deref() else {
            return LifecycleExecution::failed_definitive("invoice_missing");
        };
        if self.settlement_probe.is_none() {
            return LifecycleExecution::recovery_blocked("lightning_settlement_probe_unavailable");
        }
        let balance_before = match wallet.total_balance().await {
            Ok(balance) => balance.to_u64(),
            Err(_) => return LifecycleExecution::recovery_blocked("wallet_balance_failed"),
        };
        let quote = match wallet
            .melt_quote(PaymentMethod::BOLT11, invoice, None, None)
            .await
        {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::failed_definitive("melt_quote_rejected"),
        };
        let quote_id = quote.id.clone();
        let prepared = match wallet.prepare_melt(&quote.id, HashMap::new()).await {
            Ok(prepared) => prepared,
            Err(_) => return LifecycleExecution::failed_definitive("melt_prepare_failed"),
        };
        let input_fee = prepared.input_fee().to_u64();
        let recovery_plan = match serde_json::to_vec(&NativeMeltRecoveryPlan {
            quote_id: quote_id.clone(),
            amount: quote.amount.to_u64(),
            fee_reserve: quote.fee_reserve.to_u64(),
            balance_before,
            input_fee,
        }) {
            Ok(plan) => plan,
            Err(_) => return LifecycleExecution::recovery_blocked("melt_plan_invalid"),
        };
        let fee_reserve = quote.fee_reserve.to_u64();
        if request.prefer_async == Some(true) {
            return match prepared.confirm_prefer_async().await {
                Ok(MeltOutcome::Paid(result)) if result.state() == MeltQuoteState::Paid => {
                    let change = result
                        .change()
                        .and_then(|proofs| proofs.total_amount().ok())
                        .map_or(0, |amount| amount.to_u64());
                    self.verified_melt_execution(
                        invoice,
                        quote_id.as_bytes(),
                        &recovery_plan,
                        result.amount().to_u64(),
                        input_fee,
                        fee_reserve,
                        result.fee_paid().to_u64(),
                        change,
                    )
                    .await
                }
                Ok(MeltOutcome::Paid(_)) | Ok(MeltOutcome::Pending(_)) => {
                    LifecycleExecution::ambiguous("melt_pending")
                        .with_private_material(recovery_plan)
                }
                Err(_) => LifecycleExecution::ambiguous("melt_response_ambiguous")
                    .with_private_material(recovery_plan),
            };
        }
        match prepared.confirm().await {
            Ok(result) if result.state() == MeltQuoteState::Paid => {
                let change = result
                    .change()
                    .and_then(|proofs| proofs.total_amount().ok())
                    .map_or(0, |amount| amount.to_u64());
                self.verified_melt_execution(
                    invoice,
                    quote_id.as_bytes(),
                    &recovery_plan,
                    result.amount().to_u64(),
                    input_fee,
                    fee_reserve,
                    result.fee_paid().to_u64(),
                    change,
                )
                .await
            }
            Ok(_) => {
                LifecycleExecution::ambiguous("melt_pending").with_private_material(recovery_plan)
            }
            Err(_) => LifecycleExecution::ambiguous("melt_response_ambiguous")
                .with_private_material(recovery_plan),
        }
    }

    async fn verified_melt_execution(
        &self,
        invoice: &str,
        quote_id: &[u8],
        recovery_plan: &[u8],
        amount: u64,
        input_fee: u64,
        fee_reserve: u64,
        actual_fee: u64,
        change: u64,
    ) -> LifecycleExecution {
        let Some(probe) = self.settlement_probe.as_ref() else {
            return LifecycleExecution::recovery_blocked("lightning_settlement_probe_unavailable")
                .with_private_material(recovery_plan.to_vec());
        };
        let quote_hash = hash_parts(b"cashu-fault-lab/cdk-lifecycle-melt-quote-v1", &[quote_id]);
        match probe.settled(invoice, &quote_hash).await {
            Ok(true) => LifecycleExecution::succeeded(Some(amount), "melt_settlement_verified")
                .with_fees(input_fee, fee_reserve, actual_fee, change)
                .with_private_material(recovery_plan.to_vec()),
            Ok(false) | Err(_) => LifecycleExecution::ambiguous("lightning_settlement_unverified")
                .with_private_material(recovery_plan.to_vec()),
        }
    }

    async fn recover_melt(
        &self,
        wallet: &Wallet,
        request: &LifecycleInput,
        material: Option<&[u8]>,
    ) -> LifecycleExecution {
        let Some(material) = material else {
            return LifecycleExecution::recovery_blocked("melt_quote_identity_unavailable");
        };
        let plan = serde_json::from_slice::<NativeMeltRecoveryPlan>(material).ok();
        let quote_id = if let Some(plan) = plan.as_ref() {
            plan.quote_id.as_str()
        } else if let Ok(legacy_quote_id) = std::str::from_utf8(material) {
            legacy_quote_id
        } else {
            return LifecycleExecution::recovery_blocked("melt_quote_identity_unavailable");
        };
        let quote = match wallet.check_melt_quote_status(quote_id).await {
            Ok(quote) => quote,
            Err(_) => return LifecycleExecution::recovery_blocked("melt_quote_state_unavailable"),
        };
        match quote.state {
            MeltQuoteState::Paid => {
                let Some(invoice) = request.secret.as_deref() else {
                    return LifecycleExecution::recovery_blocked("invoice_missing")
                        .with_private_material(material.to_vec());
                };
                let Some(probe) = self.settlement_probe.as_ref() else {
                    return LifecycleExecution::recovery_blocked(
                        "lightning_settlement_probe_unavailable",
                    )
                    .with_private_material(material.to_vec());
                };
                let quote_hash = hash_parts(
                    b"cashu-fault-lab/cdk-lifecycle-melt-quote-v1",
                    &[quote_id.as_bytes()],
                );
                match probe.settled(invoice, &quote_hash).await {
                    Ok(true) => {
                        if let Some(plan) = plan.as_ref() {
                            let balance_after = match wallet.total_balance().await {
                                Ok(balance) => balance.to_u64(),
                                Err(_) => {
                                    return LifecycleExecution::recovery_blocked(
                                        "wallet_balance_failed",
                                    )
                                    .with_private_material(material.to_vec());
                                }
                            };
                            let (actual_fee, change) = match Self::melt_recovery_fees(
                                plan.balance_before,
                                balance_after,
                                plan.amount,
                                plan.input_fee,
                                plan.fee_reserve,
                            ) {
                                Ok(fees) => fees,
                                Err(code) => {
                                    return LifecycleExecution::recovery_blocked(code)
                                        .with_private_material(material.to_vec());
                                }
                            };
                            LifecycleExecution::melt_recovered(
                                plan.amount,
                                plan.fee_reserve,
                                actual_fee,
                                change,
                            )
                            .with_input_fee(plan.input_fee)
                            .with_private_material(material.to_vec())
                        } else {
                            let mut execution = LifecycleExecution::succeeded(
                                None,
                                "melt_settlement_verified_legacy",
                            );
                            execution.fee_reserve = Some(quote.fee_reserve.to_u64());
                            execution.with_private_material(material.to_vec())
                        }
                    }
                    Ok(false) | Err(_) => {
                        LifecycleExecution::recovery_blocked("lightning_settlement_unverified")
                            .with_private_material(material.to_vec())
                    }
                }
            }
            MeltQuoteState::Unpaid | MeltQuoteState::Failed => {
                LifecycleExecution::failed_definitive("melt_quote_unpaid")
                    .with_private_material(material.to_vec())
            }
            _ => LifecycleExecution::recovery_blocked("melt_quote_not_terminal")
                .with_private_material(material.to_vec()),
        }
    }

    async fn recover_receive(
        &self,
        wallet: &Wallet,
        material: Option<&[u8]>,
    ) -> LifecycleExecution {
        let Some(material) = material else {
            return LifecycleExecution::recovery_blocked("receive_plan_unavailable");
        };
        let plan: NativeReceiveRecoveryPlan = match serde_json::from_slice(material) {
            Ok(plan) => plan,
            Err(_) => return LifecycleExecution::recovery_blocked("receive_plan_invalid"),
        };
        let balance_after = match wallet.total_balance().await {
            Ok(balance) => balance.to_u64(),
            Err(_) => return LifecycleExecution::recovery_blocked("wallet_balance_failed"),
        };
        match Self::receive_recovery_amount(plan.balance_before, balance_after) {
            Ok(amount) => LifecycleExecution::succeeded(Some(amount), "receive_reconciled"),
            Err(code) => LifecycleExecution::recovery_blocked(code),
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
        *self.reset_generation.lock().await = Some(generation);
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
        self.reset_generation.lock().await.take();
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

    async fn post_commit_reset_cleanup(&self) -> Result<(), &'static str> {
        if self.facade.is_some() {
            return Ok(());
        }
        let generation = self
            .reset_generation
            .lock()
            .await
            .take()
            .ok_or("wallet_database_gc_failed")?;
        garbage_collect_inactive_wallet_generations(&self.database_path, generation)
    }

    async fn prepare(
        &self,
        request: &LifecycleInput,
    ) -> Result<Option<Vec<u8>>, LifecycleExecution> {
        if !Self::operation_bound(request.kind) {
            return Err(LifecycleExecution::recovery_blocked(
                "operation_not_applicable",
            ));
        }
        if !self.matching_request(request) {
            return Err(LifecycleExecution::failed_definitive(
                "mint_or_unit_not_configured",
            ));
        }
        if let Some(facade) = self.facade.as_ref() {
            return facade
                .prepare(request)
                .await
                .map_err(|_| LifecycleExecution::recovery_blocked("native_prepare_failed"));
        }
        let wallet = self
            .required_wallet()
            .await
            .map_err(LifecycleExecution::recovery_blocked)?;
        match request.kind {
            LifecycleKind::Swap => self.prepare_swap_plan(&wallet, request).await.map(Some),
            LifecycleKind::Send => self.prepare_send_plan(&wallet, request).await.map(Some),
            LifecycleKind::Receive => {
                let balance_before = wallet
                    .total_balance()
                    .await
                    .map_err(|_| LifecycleExecution::recovery_blocked("wallet_balance_failed"))?;
                serde_json::to_vec(&NativeReceiveRecoveryPlan {
                    balance_before: balance_before.to_u64(),
                })
                .map(Some)
                .map_err(|_| LifecycleExecution::recovery_blocked("receive_plan_invalid"))
            }
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
        if !Self::operation_bound(request.kind) {
            return LifecycleExecution::recovery_blocked("operation_not_applicable");
        }
        if !self.matching_request(request) {
            return LifecycleExecution::failed_definitive("mint_or_unit_not_configured");
        }
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
        if !Self::operation_bound(request.kind) {
            return LifecycleExecution::recovery_blocked("operation_not_applicable");
        }
        if !self.matching_request(request) {
            return LifecycleExecution::failed_definitive("mint_or_unit_not_configured");
        }
        if let Some(facade) = self.facade.as_ref() {
            if matches!(request.kind, LifecycleKind::Swap | LifecycleKind::Send) {
                return LifecycleExecution::recovery_blocked(
                    "injected_economic_recovery_unavailable",
                );
            }
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
            LifecycleKind::Melt => self.recover_melt(&wallet, request, private_material).await,
            LifecycleKind::Restore => self.execute(request).await,
            LifecycleKind::Receive => self.recover_receive(&wallet, private_material).await,
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
            let mut capabilities = facade
                .capabilities()
                .await
                .map_err(|_| "mint_capabilities_unavailable")?;
            if self.settlement_probe.is_none() {
                capabilities
                    .operations
                    .retain(|operation| *operation != "melt");
                capabilities.nuts.retain(|nut| *nut != 5);
            }
            return Ok(capabilities);
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
        let supports_melt = Self::operation_bound(LifecycleKind::Melt)
            && self.settlement_probe.is_some()
            && !info.nuts.nut05.disabled
            && info
                .nuts
                .nut05
                .get_settings(&self.unit, &PaymentMethod::BOLT11)
                .is_some();
        let supports_proof_state = info.nuts.nut07.supported;
        let supports_fee_return = info.nuts.nut08.supported;
        let supports_restore = info.nuts.nut09.supported;
        let supports_replay = supports_nut19_swap_replay(&info.nuts.nut19.cached_endpoints);
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
