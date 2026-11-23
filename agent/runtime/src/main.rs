mod model;
mod protocol;
mod session;

use protocol::{Init, Input, emit, read};
use rig_core::message::{Message, ToolResultContent};
use serde_json::{Value, json};
use session::Session;

async fn turn(
    config: &Init,
    model: &model::AgentModel,
    session: &mut Session,
    input: &mut Input,
    prompt: String,
) -> Result<Option<Value>, String> {
    session.push(Message::user(prompt), &config.api_key)?;
    let mut recovered = false;
    for _ in 0..48 {
        model::maybe_compact(model, session, config, false).await?;
        model::emit_context(session, config, "ready").await?;
        let request = model::request(
            session.projection(config.protected_context.as_deref()),
            &config.system_prompt,
            config.tools.clone(),
            config.max_output_tokens,
        )?;
        let response = match model::infer(
            model,
            request,
            config.profile == "default",
            &config.api_key,
        )
        .await
        {
            Err(error) if error == "MODEL_CONTEXT_OVERFLOW" && !recovered => {
                recovered = true;
                model::maybe_compact(model, session, config, true).await?;
                continue;
            }
            other => other?,
        };
        let provider_usage = (response.usage.input_tokens, response.usage.output_tokens);
        let calls: Vec<_> = response.tool_calls().cloned().collect();
        let message = response.message().ok_or("MODEL_EMPTY_RESPONSE")?;
        session.push(message, &config.api_key)?;
        session.last_provider_usage = Some((
            model::estimated_tokens(session, config),
            provider_usage.0,
            provider_usage.1,
        ));
        model::emit_context(session, config, "ready").await?;
        if calls.is_empty() {
            if config.profile != "default" {
                return Err("STRUCTURED_OUTPUT_REQUIRED".into());
            }
            return Ok(None);
        }
        if calls.len() > 16 {
            return Err("TOO_MANY_TOOL_CALLS".into());
        }
        let mut structured = None;
        for call in &calls {
            let name = call.function.name.to_string();
            if call.function.invalid_arguments.is_some() {
                return Err("MODEL_TOOL_ARGUMENTS_INVALID".into());
            }
            if !config.tools.iter().any(|t| t.name.to_string() == name) {
                return Err("TOOL_NOT_IN_PROFILE".into());
            }
            if config.profile == "explore_plan" && name != "StructuredOutput" {
                return Err("TOOL_PROFILE_FORBIDDEN".into());
            }
            if config.profile == "explore_analysis"
                && !matches!(name.as_str(), "Skill" | "StructuredOutput")
            {
                return Err("TOOL_PROFILE_FORBIDDEN".into());
            }
            let mut arguments = Value::Object(call.function.arguments.clone());
            let original = arguments.clone();
            protocol::redact(&mut arguments, &config.api_key);
            if arguments != original {
                return Err("TOOL_CREDENTIAL_ARGUMENT_REFUSED".into());
            }
            let id = call.id.to_string();
            emit(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":call.function.arguments}]}}), &config.api_key).await?;
            // The host validates every call before execution; output events are observations, not authorization.
            emit(
                json!({"type":"tool_request","id":id,"name":name,"input":call.function.arguments}),
                &config.api_key,
            )
            .await?;
            let reply = tokio::time::timeout(std::time::Duration::from_secs(610), read(input))
                .await
                .map_err(|_| "HOST_TOOL_TIMEOUT")??;
            if reply["type"] != "tool_response" || reply["id"] != id {
                return Err("HOST_TOOL_RESPONSE_MISMATCH".into());
            }
            let content = reply["content"]
                .as_str()
                .ok_or("HOST_TOOL_CONTENT_INVALID")?;
            if content.len() > 128 * 1024 {
                return Err("HOST_TOOL_RESULT_TOO_LARGE".into());
            }
            let failed = reply["isError"]
                .as_bool()
                .ok_or("HOST_TOOL_STATUS_INVALID")?;
            emit(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":content,"is_error":failed}]}}), &config.api_key).await?;
            session.push(
                Message::tool_results(vec![if failed {
                    call.error_result(vec![ToolResultContent::text(content)])
                } else {
                    call.result(vec![ToolResultContent::text(content)])
                }]),
                &config.api_key,
            )?;
            if name == "StructuredOutput" {
                if failed || calls.len() != 1 {
                    return Err("STRUCTURED_OUTPUT_INVALID".into());
                }
                structured = Some(Value::Object(call.function.arguments.clone()));
            }
        }
        if structured.is_some() {
            return Ok(structured);
        }
    }
    Err("AGENT_TOOL_TURN_LIMIT".into())
}
async fn run() -> Result<(), String> {
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    let first = read(&mut input).await?;
    if first["type"] != "init" {
        return Err("PROTOCOL_INIT_REQUIRED".into());
    }
    let config: Init =
        serde_json::from_value(first["config"].clone()).map_err(|_| "PROTOCOL_INIT_INVALID")?;
    if !matches!(
        config.profile.as_str(),
        "default" | "explore_analysis" | "explore_plan"
    ) || config.context_window < 16384
        || config.context_window > 2_000_000
        || config.reserve_tokens < 8192
        || config.reserve_tokens >= config.context_window
        || config.keep_recent_tokens > config.context_window / 2
        || config.max_output_tokens < 1024
        || config.max_output_tokens > 65_536
        || config.reserve_tokens < config.max_output_tokens as usize + 4096
        || config.protected_context.as_ref().is_some_and(|text| {
            text.len() > 512 * 1024 || (config.profile != "default" && !text.is_empty())
        })
    {
        return Err("AGENT_CONFIG_INVALID".into());
    }
    let model = model::create(&config)?;
    let mut session = Session::open(
        config.session_file.clone(),
        config.bootstrap.clone(),
        &config.api_key,
    )?;
    emit(json!({"type":"system","subtype":"init","runtime":"rig","protocol_version":1,"mcp_servers":[]}), &config.api_key).await?;
    loop {
        let command = match read(&mut input).await {
            Err(error) if error == "PROTOCOL_EOF" => return Ok(()),
            other => other?,
        };
        if command["type"] != "user" {
            return Err("PROTOCOL_USER_REQUIRED".into());
        }
        let prompt = command["message"]["content"]
            .as_str()
            .ok_or("PROTOCOL_PROMPT_INVALID")?
            .to_owned();
        match turn(&config, &model, &mut session, &mut input, prompt).await {
            Ok(structured) => {
                emit(json!({"type":"result","is_error":false,"result":"completed","structured_output":structured}), &config.api_key).await?;
            }
            Err(error) => {
                emit(
                    json!({"type":"result","is_error":true,"result":error}),
                    &config.api_key,
                )
                .await?;
                // A failed run is terminal: restart and recover interrupted pairs before the next task.
                return Ok(());
            }
        }
    }
}
#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("catnip-agent 0.1.0 (rig-core 0.44.0; protocol 1)");
        return;
    }
    if let Err(error) = run().await {
        let _ = emit(json!({"type":"result","is_error":true,"result":error}), "").await;
        std::process::exit(1);
    }
}
