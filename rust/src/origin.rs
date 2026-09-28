/// Exact `chrome-extension://<id>/` match against a build's enrolled ids.
/// Ids are 32 characters in `a`–`p`, as Chrome generates them.
pub fn accepts(origin: &str, extension_ids: &[&str]) -> bool {
    extension_ids.iter().any(|id| {
        id.len() == 32
            && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
            && origin.strip_prefix("chrome-extension://").and_then(|rest| rest.strip_suffix('/')) == Some(id)
    })
}

/// Chrome passes the caller origin first. On Windows it may add
/// `--parent-window=<handle>`, which is accepted and ignored.
pub fn caller_origin(args: &[String]) -> Option<&str> {
    match args {
        [origin] => Some(origin),
        [origin, extra] if extra.starts_with("--parent-window=") && cfg!(windows) => Some(origin),
        _ => None,
    }
}
