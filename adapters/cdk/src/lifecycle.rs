use std::{collections::HashMap, fmt, path::PathBuf, str::FromStr, sync::Arc};

use async_trait::async_trait;
use bitcoin::hashes::{Hash, sha256, sha512};
use cdk::{
    Amount, Wallet,
    amount::SplitTarget,
    nuts::{
        CurrencyUnit, MeltQuoteState, MintQuoteState, PaymentMethod, State, nut00::ProofsMethods,
    },
    wallet::{MeltOutcome, ReceiveOptions},
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
        }
    }
}

#[async_trait]
pub trait LifecycleWalletPort: Send + Sync {
    async fn reset(&self, seed: &str) -> Result<(), &'static str>;
    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution;
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
        while !self.store.try_claim_reset()? {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let work = self.wallet.reset(seed);
        tokio::pin!(work);
        let wallet_result = loop {
            tokio::select! {
                result = &mut work => break result.map_err(str::to_owned),
                () = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                    self.store.renew_reset()?;
                }
            }
        };
        let result = match wallet_result {
            Ok(()) => self.store.reset(seed),
            Err(error) => Err(error),
        };
        let release = self.store.release_reset();
        match (result, release) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) => Err(error),
            (_, Err(error)) => Err(error),
        }
    }

    pub async fn start(&self, mut input: LifecycleInput) -> Result<LifecycleOperation, String> {
        let _operation = self.operation_gate.read().await;
        validate_input(&input)?;
        input.mint = url::Url::parse(&input.mint)
            .map_err(|_| "lifecycle mint URL is invalid")?
            .to_string();
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
        let existing = self.store.create(&input, &created)?;
        if existing.intent_hash != created.intent_hash {
            return Err("lifecycle operation identity conflicts".to_owned());
        }
        self.run(
            &input.operation_id,
            existing.phase != LifecyclePhase::Created,
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
            if self.store.try_claim(operation_id)? {
                let work = self.run_claimed(operation_id, recovery);
                tokio::pin!(work);
                let result = loop {
                    tokio::select! {
                        result = &mut work => break result,
                        () = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                            self.store.renew_claim(operation_id)?;
                        }
                    }
                };
                let release = self.store.release(operation_id);
                return match (result, release) {
                    (Ok(value), Ok(())) => Ok(value),
                    (Err(error), _) => Err(error),
                    (_, Err(error)) => Err(error),
                };
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    async fn run_claimed(
        &self,
        operation_id: &str,
        recovery: bool,
    ) -> Result<LifecycleOperation, String> {
        let input = self.store.input(operation_id)?;
        let mut operation = self.operation(operation_id)?;
        if operation.phase.terminal() {
            return Ok(operation);
        }
        let execution = if recovery || operation.phase == LifecyclePhase::Ambiguous {
            if operation.phase != LifecyclePhase::Reconciling {
                operation.phase = LifecyclePhase::Reconciling;
                operation.evidence_code = None;
                self.store.put(&operation, None)?;
            }
            let private_material = self.store.private_material(operation_id)?;
            self.wallet
                .recover(&input, private_material.as_deref())
                .await
        } else {
            if operation.phase == LifecyclePhase::Created {
                operation.phase = LifecyclePhase::Prepared;
                operation.request_hash = Some(request_hash(&input)?);
                operation.output_plan_hash = output_plan_hash(&input);
                self.store.put(&operation, None)?;
            }
            operation.phase = LifecyclePhase::Submitted;
            self.store.put(&operation, None)?;
            self.wallet.execute(&input).await
        };
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
        )?;
        Ok(operation)
    }
}

fn validate_input(input: &LifecycleInput) -> Result<(), String> {
    validate_operation_id(&input.operation_id)?;
    if input.mint.len() > 2048 {
        return Err("lifecycle mint URL is invalid".to_owned());
    }
    let mint = url::Url::parse(&input.mint).map_err(|_| "lifecycle mint URL is invalid")?;
    if mint.scheme() != "http" && mint.scheme() != "https" {
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
            validate_operation_id(
                input
                    .target_operation_id
                    .as_deref()
                    .ok_or_else(|| "lifecycle reconciliation target is required".to_owned())?,
            )?;
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

/// Native CDK 0.17 wallet implementation. CDK's default mint connector disables redirects and
/// its saga recovery APIs are used on resume; no TypeScript wallet code is involved.
pub struct NativeCdkLifecycleWallet {
    mint_url: String,
    unit: CurrencyUnit,
    database_path: PathBuf,
    database_password: String,
    wallet: Mutex<Option<Arc<Wallet>>>,
}

impl NativeCdkLifecycleWallet {
    pub const fn operation_bound(kind: LifecycleKind) -> bool {
        matches!(
            kind,
            LifecycleKind::Mint
                | LifecycleKind::Receive
                | LifecycleKind::Melt
                | LifecycleKind::Restore
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
        })
    }

    async fn required_wallet(&self) -> Result<Arc<Wallet>, &'static str> {
        self.wallet
            .lock()
            .await
            .clone()
            .ok_or("wallet_not_initialized")
    }

    pub async fn load(&self, seed: &str) -> Result<(), &'static str> {
        self.initialize(seed, false).await
    }

    async fn initialize(&self, seed: &str, reset: bool) -> Result<(), &'static str> {
        if seed.is_empty() {
            return Err("invalid_seed");
        }
        if reset {
            *self.wallet.lock().await = None;
            for path in [
                self.database_path.clone(),
                PathBuf::from(format!("{}-wal", self.database_path.display())),
                PathBuf::from(format!("{}-shm", self.database_path.display())),
            ] {
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("wallet_database_reset_failed"),
                }
            }
        }
        let mut material = b"cashu-fault-lab/cdk-lifecycle-wallet-seed-v1".to_vec();
        material.push(0);
        material.extend_from_slice(seed.as_bytes());
        let wallet_seed = sha512::Hash::hash(&material).to_byte_array();
        let database = cdk_sqlite::WalletSqliteDatabase::new((
            self.database_path.clone(),
            self.database_password.clone(),
        ))
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
        *self.wallet.lock().await = Some(wallet);
        Ok(())
    }

    fn matching_request(&self, request: &LifecycleInput) -> bool {
        request.mint.trim_end_matches('/') == self.mint_url && request.unit == self.unit.to_string()
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
        self.initialize(seed, true).await
    }

    async fn execute(&self, request: &LifecycleInput) -> LifecycleExecution {
        if !Self::operation_bound(request.kind) {
            return LifecycleExecution::recovery_blocked("operation_not_applicable");
        }
        if !self.matching_request(request) {
            return LifecycleExecution::failed_definitive("mint_or_unit_not_configured");
        }
        let wallet = match self.required_wallet().await {
            Ok(wallet) => wallet,
            Err(code) => return LifecycleExecution::recovery_blocked(code),
        };
        match request.kind {
            LifecycleKind::Mint => self.execute_mint(&wallet, request).await,
            LifecycleKind::Swap | LifecycleKind::Send | LifecycleKind::Reconcile => {
                LifecycleExecution::recovery_blocked("operation_not_applicable")
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

    async fn recover(
        &self,
        request: &LifecycleInput,
        private_material: Option<&[u8]>,
    ) -> LifecycleExecution {
        let wallet = match self.required_wallet().await {
            Ok(wallet) => wallet,
            Err(code) => return LifecycleExecution::recovery_blocked(code),
        };
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
            LifecycleKind::Swap | LifecycleKind::Send | LifecycleKind::Reconcile => {
                LifecycleExecution::recovery_blocked("operation_not_applicable")
            }
        }
    }

    async fn wallet(&self) -> Result<LifecycleWalletView, &'static str> {
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
        let mut operations = vec!["receive"];
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
        let mut recovery = Vec::new();
        if supports_mint || supports_melt {
            recovery.push("quote_state");
        }
        if supports_proof_state {
            recovery.push("proof_state");
        }
        if supports_restore {
            recovery.extend(["nut09_restore", "nut13_seed"]);
        }
        if supports_replay {
            recovery.push("nut19_replay");
        }
        Ok(LifecycleRuntimeCapabilities {
            operations,
            nuts,
            recovery,
        })
    }
}
