use rig_core::completion::ToolDefinition;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdin};

pub type Input = BufReader<Stdin>;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Init {
    pub profile: String,
    pub system_prompt: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub auth_field: String,
    pub tools: Vec<ToolDefinition>,
    pub session_file: Option<String>,
    pub bootstrap: Option<String>,
    pub context_window: usize,
    pub reserve_tokens: usize,
    pub keep_recent_tokens: usize,
    #[serde(default = "default_output_tokens")]
    pub max_output_tokens: u64,
    #[serde(default)]
    pub protected_context: Option<String>,
}

fn default_output_tokens() -> u64 {
    4096
}
pub async fn read(input: &mut Input) -> Result<Value, String> {
    // Bound allocation before a newline arrives, including a malformed host frame.
    let mut bytes = Vec::new();
    loop {
        let available = input.fill_buf().await.map_err(|_| "PROTOCOL_READ_FAILED")?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Err("PROTOCOL_EOF".into());
            }
            return Err("PROTOCOL_PARTIAL_FRAME".into());
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if bytes.len() + take > 2 * 1024 * 1024 {
            return Err("PROTOCOL_MESSAGE_TOO_LARGE".into());
        }
        bytes.extend_from_slice(&available[..take]);
        let complete = bytes.last() == Some(&b'\n');
        input.consume(take);
        if complete {
            break;
        }
    }
    serde_json::from_slice(&bytes).map_err(|_| "PROTOCOL_INVALID_JSON".into())
}
pub fn redact(value: &mut Value, secret: &str) {
    if secret.len() < 8 {
        return;
    }
    match value {
        Value::String(text) => *text = text.replace(secret, "[credential redacted]"),
        Value::Array(items) => {
            for item in items {
                redact(item, secret);
            }
        }
        Value::Object(fields) => {
            let old = std::mem::take(fields);
            for (key, mut value) in old {
                redact(&mut value, secret);
                fields.insert(key.replace(secret, "[credential redacted]"), value);
            }
        }
        _ => {}
    }
}
pub async fn emit(mut value: Value, secret: &str) -> Result<(), String> {
    redact(&mut value, secret);
    let encoded = serde_json::to_string(&value).map_err(|_| "PROTOCOL_ENCODE_FAILED")?;
    let mut output = tokio::io::stdout();
    output
        .write_all(encoded.as_bytes())
        .await
        .map_err(|_| "PROTOCOL_WRITE_FAILED")?;
    output
        .write_all(b"\n")
        .await
        .map_err(|_| "PROTOCOL_WRITE_FAILED")?;
    output
        .flush()
        .await
        .map_err(|_| "PROTOCOL_WRITE_FAILED".into())
}
