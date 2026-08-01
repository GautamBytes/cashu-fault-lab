use std::net::SocketAddr;

pub fn validate_lifecycle_listen_address(
    address: &str,
    lifecycle_enabled: bool,
) -> Result<(), String> {
    if !lifecycle_enabled {
        return Ok(());
    }
    let parsed = address
        .parse::<SocketAddr>()
        .map_err(|_| "CASHU_FAULT_LAB_CDK_LISTEN must be a socket address".to_owned())?;
    if parsed.ip().is_loopback() {
        Ok(())
    } else {
        Err("CASHU_FAULT_LAB_CDK_LISTEN must be loopback when lifecycle mode is enabled".to_owned())
    }
}
