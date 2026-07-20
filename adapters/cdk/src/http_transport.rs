use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, redirect::Policy};

use crate::funded::{DeliveryReceipt, TransportPort};

const MAX_RESPONSE_BYTES: usize = 65_536;

pub struct CdkHttpTransport {
    client: Client,
}

impl CdkHttpTransport {
    pub fn new(timeout: Duration) -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|_| "CDK HTTP transport initialization failed".to_owned())?;
        Ok(Self { client })
    }
}

#[async_trait]
impl TransportPort for CdkHttpTransport {
    async fn post(&self, target: &str, body: &[u8]) -> Result<DeliveryReceipt, String> {
        if body.len() > MAX_RESPONSE_BYTES {
            return Err("Cashu payment payload is too large".to_owned());
        }
        let mut response = self
            .client
            .post(target)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .body(body.to_vec())
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "Cashu payment delivery timed out".to_owned()
                } else {
                    "Cashu payment delivery failed".to_owned()
                }
            })?;
        if response.status().is_redirection() {
            return Err("Cashu payment redirect is forbidden".to_owned());
        }
        if !response.status().is_success() {
            return Err(format!(
                "Cashu receiver returned HTTP {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err("Cashu payment response is too large".to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Cashu payment response is invalid".to_owned())?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("Cashu payment response is too large".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Cashu payment response is invalid".to_owned())
    }
}
