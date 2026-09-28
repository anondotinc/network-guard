//! Provider CLI output to a tunnel state. Only the discriminant is kept; IPs,
//! accounts, servers and keys are discarded in-process and never logged.
use crate::error::{HelperError, Result};
use crate::provider::TUNNEL_STATES;
use serde_json::Value;

/// `mullvad status --json`. Warnings before the JSON, future shapes and unknown
/// states fail closed.
pub fn mullvad(output: &[u8]) -> Result<&'static str> {
    if output.len() > 65536 {
        return Err(HelperError::UnrecognizedStatus);
    }
    match serde_json::from_slice::<Value>(output) {
        Ok(Value::Object(object)) => match object.get("state") {
            Some(Value::String(state)) => TUNNEL_STATES.into_iter().find(|known| known == state).ok_or(HelperError::UnrecognizedStatus),
            _ => Err(HelperError::UnrecognizedStatus),
        },
        _ => Err(HelperError::UnrecognizedStatus),
    }
}

/// Foundation's `CharacterSet.newlines`.
fn is_newline(c: char) -> bool {
    matches!(c, '\n' | '\u{000B}' | '\u{000C}' | '\r' | '\u{0085}' | '\u{2028}' | '\u{2029}')
}

/// Foundation's `CharacterSet.whitespaces`: tab plus Unicode space separators.
fn is_space(c: char) -> bool {
    c == '\t' || (c.is_whitespace() && !is_newline(c))
}

/// `ivpn status` prints exactly one top-level `VPN : STATE` line.
pub fn ivpn(output: &[u8]) -> Result<&'static str> {
    let text = match std::str::from_utf8(output) {
        Ok(text) if output.len() <= 65536 => text,
        _ => return Err(HelperError::UnrecognizedStatus),
    };
    let states: Vec<&str> = text
        .split(is_newline)
        .filter_map(|line| {
            if !line.starts_with("VPN") {
                return None;
            }
            let (key, value) = line.split_once(':')?;
            (key.trim_matches(is_space) == "VPN").then(|| value.trim_matches(is_space))
        })
        .collect();
    let [state] = states.as_slice() else {
        return Err(HelperError::UnrecognizedStatus);
    };
    Ok(match *state {
        "CONNECTED" if text.contains("WARNING! Unhealthy Connection") => "error",
        "CONNECTED" => "connected",
        "DISCONNECTED" => "disconnected",
        "CONNECTING" | "WAIT" | "AUTH" | "GETCONFIG" | "ASSIGNIP" | "ADDROUTES" | "RECONNECTING" | "TCP_CONNECT" | "INITIALISED" => {
            "connecting"
        }
        "EXITING" => "disconnecting",
        // A paused VPN must not be green or silently resumed by auto-connect.
        paused if paused == "PAUSED" || paused.starts_with("PAUSED till ") => "error",
        _ => return Err(HelperError::UnrecognizedStatus),
    })
}
