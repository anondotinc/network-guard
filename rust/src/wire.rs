//! Request parsing that reproduces the Swift helper's Foundation behaviour
//! exactly, so the conformance fixtures hold on every platform.
use crate::error::HelperError;
use serde_json::{Map, Value};

pub type Object = Map<String, Value>;

/// `JSONSerialization.jsonObject(with:) as? [String: Any]`.
pub fn object(payload: &[u8]) -> Option<Object> {
    match serde_json::from_slice::<Value>(payload) {
        Ok(Value::Object(object)) => Some(object),
        _ => None,
    }
}

/// `object["v"] as? Int`: integral numbers only. Booleans never select a
/// version here; the fixtures show both bridgings end in the same v1 reply.
pub fn int(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_number()?;
    if let Some(value) = number.as_i64() {
        return Some(value);
    }
    let value = number.as_f64()?;
    (value.fract() == 0.0 && value.abs() < 9.0e15).then_some(value as i64)
}

/// `NSNumber` that is not a boolean and equals `expected` numerically.
pub fn is_version(value: Option<&Value>, expected: i64) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64() == Some(expected as f64))
}

pub fn has_keys(object: &Object, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

/// A 36-character UUID string, any hex case, as `UUID(uuidString:)` accepts.
pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// The lowercase request id, when `v,id,method` or `v,id,method,provider`
/// has the exact key set, a UUID id and a string method.
pub struct Envelope {
    pub id: String,
    pub method: String,
    pub object: Object,
}

pub fn envelope(payload: &[u8], keys: &[&str]) -> Result<Envelope, HelperError> {
    if payload.len() > crate::frames::MAX_BYTES {
        return Err(HelperError::InvalidRequest);
    }
    let object = object(payload).ok_or(HelperError::InvalidRequest)?;
    if !has_keys(&object, keys) {
        return Err(HelperError::InvalidRequest);
    }
    let id = match object.get("id") {
        Some(Value::String(id)) if is_uuid(id) => id.to_ascii_lowercase(),
        _ => return Err(HelperError::InvalidRequest),
    };
    let method = match object.get("method") {
        Some(Value::String(method)) => method.clone(),
        _ => return Err(HelperError::InvalidRequest),
    };
    Ok(Envelope { id, method, object })
}

/// Builds a response object. Absent optionals are omitted, as Swift's encoder
/// does, and keys serialize sorted because `Map` is ordered by key.
pub fn response(version: i64, id: Option<&str>, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("v".into(), Value::from(version));
    if let Some(id) = id {
        object.insert("id".into(), Value::from(id));
    }
    for (key, value) in fields {
        object.insert(key.into(), value);
    }
    Value::Object(object)
}

pub fn failure(version: i64, id: Option<&str>, error: HelperError) -> Value {
    response(version, id, vec![("ok", Value::Bool(false)), ("error", Value::from(error.code()))])
}

pub fn strings(values: &[&str]) -> Value {
    Value::Array(values.iter().map(|value| Value::from(*value)).collect())
}
