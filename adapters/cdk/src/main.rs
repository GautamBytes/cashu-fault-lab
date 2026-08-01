use std::{env, sync::Arc, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use cashu_fault_lab_cdk_adapter::{
    funded::FundedCdkOperations,
    funded_wallet::FundedCdkWallet,
    http_transport::CdkHttpTransport,
    lifecycle::{LifecycleEngine, NativeCdkLifecycleWallet},
    lifecycle_store::LifecycleStore,
    server::router_with_lifecycle,
};

fn positive_env(name: &str, default: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("{name} must be a positive integer")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(_) => Err(format!("{name} is invalid")),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let control_token = env::var("CASHU_FAULT_LAB_CONTROL_TOKEN")
        .map_err(|_| "CASHU_FAULT_LAB_CONTROL_TOKEN is required")?;
    let mint_url = match env::var("CASHU_FAULT_LAB_CDK_MINT_URL") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("CASHU_FAULT_LAB_CDK_MINT_URL is invalid".into()),
    };
    let operations = match &mint_url {
        Some(mint_url) => {
            let funding_amount = positive_env("CASHU_FAULT_LAB_CDK_FUNDING_AMOUNT", 1_024)?;
            let funding_timeout = positive_env("CASHU_FAULT_LAB_CDK_FUNDING_TIMEOUT_SECONDS", 10)?;
            let request_timeout = positive_env("CASHU_FAULT_LAB_CDK_HTTP_TIMEOUT_SECONDS", 5)?;
            let wallet = Arc::new(FundedCdkWallet::new(
                mint_url,
                "sat",
                funding_amount,
                Duration::from_secs(funding_timeout),
            )?);
            let transport = Arc::new(CdkHttpTransport::new(Duration::from_secs(request_timeout))?);
            Some(Arc::new(FundedCdkOperations::new(
                wallet,
                transport,
                || {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .expect("system clock must be after Unix epoch")
                        .as_secs()
                },
            )))
        }
        None => None,
    };
    let lifecycle = match env::var("CASHU_FAULT_LAB_CDK_LIFECYCLE_DATABASE_PATH") {
        Ok(database_path) => {
            let mint_url = mint_url
                .as_deref()
                .ok_or("CASHU_FAULT_LAB_CDK_MINT_URL is required for lifecycle mode")?;
            let encoded_key = env::var("CASHU_FAULT_LAB_CDK_LIFECYCLE_STATE_KEY")
                .map_err(|_| "CASHU_FAULT_LAB_CDK_LIFECYCLE_STATE_KEY is required")?;
            let decoded_key = URL_SAFE_NO_PAD
                .decode(encoded_key)
                .map_err(|_| "CASHU_FAULT_LAB_CDK_LIFECYCLE_STATE_KEY is invalid")?;
            let state_key: [u8; 32] = decoded_key
                .try_into()
                .map_err(|_| "CASHU_FAULT_LAB_CDK_LIFECYCLE_STATE_KEY must decode to 32 bytes")?;
            let wallet_database_path = env::var("CASHU_FAULT_LAB_CDK_LIFECYCLE_WALLET_PATH")
                .unwrap_or_else(|_| format!("{database_path}.wallet"));
            let store = Arc::new(LifecycleStore::open(&database_path, state_key)?);
            let wallet = Arc::new(NativeCdkLifecycleWallet::new(
                mint_url,
                "sat",
                wallet_database_path.into(),
                hex::encode(state_key),
            )?);
            if store.seed_hash()?.is_some() {
                let seed = env::var("CASHU_FAULT_LAB_CDK_LIFECYCLE_SEED").map_err(
                    |_| "CASHU_FAULT_LAB_CDK_LIFECYCLE_SEED is required to reopen lifecycle state",
                )?;
                if !store.verify_seed(&seed)? {
                    return Err(
                        "CASHU_FAULT_LAB_CDK_LIFECYCLE_SEED does not match stored state".into(),
                    );
                }
                wallet.load(&seed).await.map_err(|code| code.to_owned())?;
            }
            Some(Arc::new(LifecycleEngine::new(store, wallet)))
        }
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("CASHU_FAULT_LAB_CDK_LIFECYCLE_DATABASE_PATH is invalid".into()),
    };
    let address =
        env::var("CASHU_FAULT_LAB_CDK_LISTEN").unwrap_or_else(|_| "127.0.0.1:8088".to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    axum::serve(
        listener,
        router_with_lifecycle(&control_token, operations, lifecycle)?.into_make_service(),
    )
    .await?;
    Ok(())
}
