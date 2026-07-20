use std::{env, sync::Arc, time::Duration};

use cashu_fault_lab_cdk_adapter::{funded::WalletPort, funded_wallet::FundedCdkWallet};

#[tokio::test]
async fn funds_and_reserves_real_cdk_proofs_when_mint_is_configured() {
    let Ok(mint_url) = env::var("CFL_REAL_MINT_URL") else {
        return;
    };
    let wallet =
        Arc::new(FundedCdkWallet::new(&mint_url, "sat", 16, Duration::from_secs(30)).unwrap());
    wallet.reset("docker-funded-cdk-wallet").await.unwrap();
    let reserved = wallet
        .reserve(
            8,
            "sat",
            std::slice::from_ref(&mint_url),
            "EBESExQVFhcYGRobHB0eHw",
        )
        .await
        .unwrap();

    assert!(!reserved.proofs.is_empty());
    assert_eq!(reserved.input_ys.len(), reserved.proofs.len());
    assert_eq!(reserved.proof_set_hash.len(), 64);
    let evidence = serde_json::json!({
        "deliveryId": "EBESExQVFhcYGRobHB0eHw",
        "proofSetHash": reserved.proof_set_hash,
        "inputYs": reserved.input_ys,
        "state": "pending",
    });
    let evidence_text = serde_json::to_string(&evidence).unwrap();
    for proof in &reserved.proofs {
        assert!(!evidence_text.contains(proof["secret"].as_str().unwrap()));
    }
}
