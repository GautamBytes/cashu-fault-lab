//! Offline NUT-26 codec probe. No wallets, mint calls or relay connections.
use std::io::{self, Read};
use std::str::FromStr;

use cdk::nuts::PaymentRequest;
use serde::Deserialize;
use serde_json::json;

const MAX_INPUT: u64 = 65_536;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    encoded: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin().take(MAX_INPUT + 1).read_to_end(&mut input)?;
    if input.len() as u64 > MAX_INPUT {
        return Err("codec input exceeds 64 KiB".into());
    }
    let input: Input = serde_json::from_slice(&input)?;
    // Call the upstream decoder directly: lab prevalidation must not hide SDK acceptance bugs.
    let output = match PaymentRequest::from_str(&input.encoded) {
        Err(_) => json!({ "accepted": false }),
        Ok(request) => {
            let mut raw = serde_json::to_value(&request)?;
            if let Some(amount) = request.amount {
                raw["a"] = json!(amount.to_u64().to_string());
            }
            json!({
                "accepted": true,
                "raw": raw,
                "encoded": request.to_bech32_string().ok(),
            })
        }
    };
    println!("{output}");
    Ok(())
}
