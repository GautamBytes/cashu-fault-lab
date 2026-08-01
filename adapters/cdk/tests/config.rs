use cashu_fault_lab_cdk_adapter::config::validate_lifecycle_listen_address;

#[test]
fn lifecycle_listen_address_requires_loopback_when_lifecycle_is_enabled() {
    assert!(validate_lifecycle_listen_address("127.0.0.1:4102", true).is_ok());
    assert!(validate_lifecycle_listen_address("[::1]:4102", true).is_ok());
    assert!(validate_lifecycle_listen_address("0.0.0.0:4102", false).is_ok());
    assert_eq!(
        validate_lifecycle_listen_address("0.0.0.0:4102", true).unwrap_err(),
        "CASHU_FAULT_LAB_CDK_LISTEN must be loopback when lifecycle mode is enabled"
    );
}
