use std::time::Duration;

use cashu_fault_lab_cdk_adapter::lightning_probe::HttpCdkLightningSettlementProbe;

#[test]
fn settlement_probe_rejects_unsafe_origins_credentials_and_tokens() {
    let token = "local-regtest-probe-token".to_owned();
    assert!(
        HttpCdkLightningSettlementProbe::new(
            "http://example.com/v1/settlement",
            token.clone(),
            Duration::from_secs(5),
            false,
        )
        .is_err()
    );
    assert!(
        HttpCdkLightningSettlementProbe::new(
            "http://user:password@127.0.0.1:4400/v1/settlement",
            token,
            Duration::from_secs(5),
            false,
        )
        .is_err()
    );
    assert!(
        HttpCdkLightningSettlementProbe::new(
            "http://127.0.0.1:4400/v1/settlement",
            "short".to_owned(),
            Duration::from_secs(5),
            false,
        )
        .is_err()
    );
}

#[test]
fn settlement_probe_accepts_a_bounded_loopback_endpoint() {
    assert!(
        HttpCdkLightningSettlementProbe::new(
            "http://127.0.0.1:4400/v1/settlement",
            "local-regtest-probe-token".to_owned(),
            Duration::from_secs(5),
            false,
        )
        .is_ok()
    );
}
