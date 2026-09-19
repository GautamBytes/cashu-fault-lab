use super::{Result, protocol::local_url};
use futures_util::{SinkExt, StreamExt};
use nostr::prelude::Event;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

async fn exchange(url: &str, request: Value, event_id: Option<String>) -> Result<Vec<Event>> {
    local_url(url, "ws")?;
    tokio::time::timeout(Duration::from_millis(1500), async {
        let config = WebSocketConfig::default()
            .max_message_size(Some(262144))
            .max_frame_size(Some(262144));
        let (mut socket, _) = connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|_| "relay_connect_failed")?;
        socket
            .send(Message::Text(request.to_string().into()))
            .await
            .map_err(|_| "relay_send_failed")?;
        let mut events = Vec::new();
        let mut messages = 0;
        while let Some(message) = socket.next().await {
            messages += 1;
            if messages > 256 {
                return Err("relay_message_limit");
            }
            let message = message.map_err(|_| "relay_receive_failed")?;
            let Message::Text(text) = message else {
                continue;
            };
            let v: Value = serde_json::from_str(&text).map_err(|_| "invalid_relay_message")?;
            if let Some(id) = &event_id {
                if v[0] == "OK" && v[1] == *id {
                    return if v[2] == true {
                        Ok(events)
                    } else {
                        Err("relay_rejected_event")
                    };
                }
            } else if v[1] == "cdk-nutzap" {
                if v[0] == "EOSE" {
                    return Ok(events);
                }
                if v[0] == "EVENT" {
                    if events.len() >= 128 {
                        return Err("relay_event_limit");
                    }
                    if let Ok(event) = serde_json::from_value::<Event>(v[2].clone())
                        && event.verify().is_ok()
                    {
                        events.push(event);
                    }
                }
            }
        }
        Err("relay_closed")
    })
    .await
    .map_err(|_| "relay_timeout")?
}
pub async fn query(url: &str, author: &str) -> Result<Vec<Event>> {
    exchange(
        url,
        json!(["REQ", "cdk-nutzap", {"kinds": [7375,7376,5],"authors": [author],"limit":128}]),
        None,
    )
    .await
}
pub async fn publish(url: &str, event: &Event) -> Result<()> {
    exchange(url, json!(["EVENT", event]), Some(event.id.to_hex())).await?;
    Ok(())
}
