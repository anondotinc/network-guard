//! Chrome native messaging framing: a 4-byte little-endian length, then UTF-8
//! JSON. Much tighter than Chrome's limit, as in `NativeFrames.swift`.
use crate::error::{HelperError, Result};
use std::io::{ErrorKind, Read};

pub const MAX_BYTES: usize = 4096;

pub fn encode(payload: &[u8]) -> Result<Vec<u8>> {
    if payload.is_empty() || payload.len() > MAX_BYTES {
        return Err(HelperError::InvalidFrame);
    }
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn length(header: [u8; 4]) -> Result<usize> {
    let value = u32::from_le_bytes(header) as usize;
    if value == 0 || value > MAX_BYTES {
        return Err(HelperError::InvalidFrame);
    }
    Ok(value)
}

/// Reads exactly `buffer.len()` bytes. `Ok(false)` only for EOF before the first byte.
fn exact(input: &mut impl Read, buffer: &mut [u8]) -> Result<bool> {
    let mut filled = 0;
    while filled < buffer.len() {
        match input.read(&mut buffer[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(HelperError::InvalidFrame),
            Ok(count) => filled += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err(HelperError::InvalidFrame),
        }
    }
    Ok(true)
}

/// `Ok(None)` is a clean EOF between frames; anything partial is `InvalidFrame`.
pub fn read(input: &mut impl Read) -> Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    if !exact(input, &mut header)? {
        return Ok(None);
    }
    let mut payload = vec![0u8; length(header)?];
    if !exact(input, &mut payload)? {
        return Err(HelperError::InvalidFrame);
    }
    Ok(Some(payload))
}
