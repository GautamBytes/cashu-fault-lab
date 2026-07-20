use std::{env, sync::Arc, time::Duration};

use cashu_fault_lab_cdk_adapter::{
    funded::FundedCdkOperations, funded_wallet::FundedCdkWallet, http_transport::CdkHttpTransport,
    server::router,
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
    let operations = match env::var("CASHU_FAULT_LAB_CDK_MINT_URL") {
        Ok(mint_url) => {
            let funding_amount = positive_env("CASHU_FAULT_LAB_CDK_FUNDING_AMOUNT", 1_024)?;
            let funding_timeout = positive_env("CASHU_FAULT_LAB_CDK_FUNDING_TIMEOUT_SECONDS", 10)?;
            let request_timeout = positive_env("CASHU_FAULT_LAB_CDK_HTTP_TIMEOUT_SECONDS", 5)?;
            let wallet = Arc::new(FundedCdkWallet::new(
                &mint_url,
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
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("CASHU_FAULT_LAB_CDK_MINT_URL is invalid".into()),
    };
    let address =
        env::var("CASHU_FAULT_LAB_CDK_LISTEN").unwrap_or_else(|_| "127.0.0.1:8088".to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    axum::serve(
        listener,
        router(&control_token, operations)?.into_make_service(),
    )
    .await?;
    Ok(())
}
