//! Read-only fixture import: at most two retained keys for one identity and mint.
use std::os::unix::fs::PermissionsExt;

use nostr::prelude::{Event, Keys, PublicKey};
use rusqlite::{Connection, OpenFlags};

use super::{Config, Result, protocol};

fn profile(info: &Event, recipient: &str) -> Result<(String, String)> {
    info.verify().map_err(|_| "invalid_info_signature")?;
    let keys = protocol::tags(info, "pubkey");
    let mints = protocol::tags(info, "mint");
    if info.kind.as_u16() != 10019
        || info.pubkey.to_hex() != recipient
        || info.created_at.as_secs() > 9_007_199_254_740_991
        || keys.len() != 1
        || keys[0].len() != 2
        || keys[0][1].len() != 64
        || PublicKey::from_hex(&keys[0][1]).is_err()
        || keys[0][1] == recipient
        || mints.len() != 1
        || !(mints[0].len() == 2 || (mints[0].len() == 3 && mints[0][2] == "sat"))
    {
        return Err("invalid_receiving_profile");
    }
    protocol::local_url(&mints[0][1], "http")?;
    Ok((keys[0][1].clone(), mints[0][1].clone()))
}

/// Validate the complete retained history before selecting any key or contacting a mint.
/// None means a valid matching advertisement exists but its private key is missing.
pub(super) fn select(config: &Config) -> Result<Option<(Event, String)>> {
    let path = config
        .receiving_keys
        .as_ref()
        .ok_or("missing_key_history")?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "key_history_unavailable")?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("insecure_key_history");
    }
    let recipient = Keys::parse(&config.key_hex)
        .map_err(|_| "invalid_wallet_key")?
        .public_key()
        .to_hex();
    let (_, mint) = profile(&config.info, &recipient)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "key_history_unavailable")?;
    // Bound bytes before copying SQLite values into Rust; inspect a third row only to reject it.
    let mut statement = db
        .prepare(
            "SELECT substr(pubkey,1,65),
        CASE WHEN length(CAST(info AS BLOB)) <= 65536 THEN info ELSE NULL END,
        CASE WHEN secret IS NULL OR length(CAST(secret AS BLOB)) = 64 THEN secret ELSE '' END
        FROM receiving_keys LIMIT 3",
        )
        .map_err(|_| "invalid_key_history")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| "invalid_key_history")?;
    let mut entries = Vec::new();
    for row in rows {
        let (key, json, secret) = row.map_err(|_| "invalid_key_history")?;
        if entries.len() == 2 {
            return Err("too_many_receiving_keys");
        }
        let info: Event = serde_json::from_str(&json).map_err(|_| "invalid_key_history")?;
        let (advertised_key, advertised_mint) = profile(&info, &recipient)?;
        if key != advertised_key || mint != advertised_mint {
            return Err("receiving_key_trust_changed");
        }
        if let Some(value) = &secret
            && (value.len() != 64
                || !value.bytes().all(|b| b.is_ascii_hexdigit())
                || Keys::parse(value)
                    .map_err(|_| "invalid_lock_key")?
                    .public_key()
                    .to_hex()
                    != key)
        {
            return Err("wrong_receiving_secret");
        }
        entries.push((info, secret));
    }
    if !entries.iter().any(|(info, _)| info.id == config.info.id) {
        return Err("unknown_receiving_advertisement");
    }
    for (info, secret) in entries {
        if protocol::validate_for_info(config, &info).is_ok() {
            return Ok(secret.map(|secret| (info, secret)));
        }
    }
    Err("unmatched_receiving_key")
}
