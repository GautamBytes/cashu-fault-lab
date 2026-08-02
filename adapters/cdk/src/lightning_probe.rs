use std::time::Duration;

use async_trait::async_trait;
use bitcoin::hashes::{Hash, sha256};
use reqwest::{Client, redirect::Policy};
use serde::{Deserialize, Serialize};

const MAX_RESPONSE_BYTES: usize = 8_192;

#[async_trait]
pub trait CdkLightningSettlementProbe: Send + Sync {
    async fn settled(&self, invoice: &str, quote_hash: &str) -> Result<bool, String>;
}

pub struct HttpCdkLightningSettlementProbe {
    client: Client,
    url: url::Url,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettlementRequest<'a> {
    invoice: &'a str,
    invoice_hash: String,
    quote_hash: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettlementResponse {
    settled: bool,
    invoice_hash: String,
    quote_hash: String,
}

fn invoice_hash(invoice: &str) -> String {
    let mut material = b"cashu-fault-lab/lightning-invoice/v1".to_vec();
    material.push(0);
    material.extend_from_slice(invoice.as_bytes());
    sha256::Hash::hash(&material).to_string()
}

fn loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

impl HttpCdkLightningSettlementProbe {
    pub fn new(
        value: &str,
        token: String,
        timeout: Duration,
        allow_unsafe_external: bool,
    ) -> Result<Self, String> {
        let url = url::Url::parse(value)
            .map_err(|_| "CDK lifecycle Lightning probe URL is invalid".to_owned())?;
        let safe_loopback = url.host_str().is_some_and(loopback) && url.scheme() == "http";
        let safe_external = allow_unsafe_external && url.scheme() == "https";
        if (!safe_loopback && !safe_external)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("CDK lifecycle Lightning probe URL is invalid".to_owned());
        }
        if token.len() < 16 || token.len() > 4_096 || token.contains(['\r', '\n']) {
            return Err("CDK lifecycle Lightning probe token is invalid".to_owned());
        }
        if timeout.is_zero() || timeout > Duration::from_secs(30) {
            return Err("CDK lifecycle Lightning probe timeout is invalid".to_owned());
        }
        let client = Client::builder()
            .timeout(timeout)
            .redirect(Policy::none())
            .referer(false)
            .build()
            .map_err(|_| "CDK lifecycle Lightning probe client is invalid".to_owned())?;
        Ok(Self { client, url, token })
    }
}

#[async_trait]
impl CdkLightningSettlementProbe for HttpCdkLightningSettlementProbe {
    async fn settled(&self, invoice: &str, quote_hash: &str) -> Result<bool, String> {
        if invoice.len() < 16 || invoice.len() > 4_096 || quote_hash.len() != 64 {
            return Err("CDK lifecycle Lightning settlement binding is invalid".to_owned());
        }
        let expected_invoice_hash = invoice_hash(invoice);
        let mut response = self
            .client
            .post(self.url.clone())
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&SettlementRequest {
                invoice,
                invoice_hash: expected_invoice_hash.clone(),
                quote_hash,
            })
            .send()
            .await
            .map_err(|_| "CDK lifecycle Lightning settlement is unavailable".to_owned())?;
        if response.status().is_redirection() || !response.status().is_success() {
            return Ok(false);
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err("CDK lifecycle Lightning probe response is too large".to_owned());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "CDK lifecycle Lightning settlement is unavailable".to_owned())?
        {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("CDK lifecycle Lightning probe response is too large".to_owned());
            }
            body.extend_from_slice(&chunk);
        }
        let value: SettlementResponse = serde_json::from_slice(&body)
            .map_err(|_| "CDK lifecycle Lightning probe response is invalid".to_owned())?;
        Ok(value.settled
            && value.invoice_hash == expected_invoice_hash
            && value.quote_hash == quote_hash)
    }
}
