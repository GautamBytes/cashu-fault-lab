use cashu_fault_lab_cdk_adapter::nutzap::{Config, Result, receive};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn read<R: BufRead>(input: &mut R, limit: u64) -> Result<String> {
    let mut line = String::new();
    std::io::Read::take(&mut *input, limit + 1)
        .read_line(&mut line)
        .map_err(|_| "input_failed")?;
    if line.is_empty() || line.len() as u64 > limit || !line.ends_with('\n') {
        return Err("invalid_input_frame");
    }
    Ok(line)
}
fn emit(value: Value) -> Result<()> {
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{value}")
        .and_then(|()| stdout.flush())
        .map_err(|_| "output_failed")
}
#[tokio::main]
async fn main() {
    let result = async {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let config: Config = serde_json::from_str(&read(&mut input, 262144)?)
            .map_err(|_| "invalid_receiver_config")?;
        let result = receive(config, |phase| {
            emit(json!({"type":"checkpoint", "phase":phase}))?;
            let value: Value = serde_json::from_str(&read(&mut input, 1024)?)
                .map_err(|_| "invalid_checkpoint_reply")?;
            if value != json!({"continue":true}) {
                return Err("invalid_checkpoint_reply");
            }
            Ok(())
        })
        .await?;
        emit(json!({"type":"result", "result":result}))
    }
    .await;
    if let Err(code) = result {
        // Static codes only: never log bearer proofs, keys, mint responses or decrypted history.
        eprintln!("CDK nutzap receiver: {code}");
        std::process::exit(1);
    }
}
