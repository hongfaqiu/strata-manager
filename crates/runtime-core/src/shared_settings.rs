//! Chat settings (`*.shared-settings.json`) copied to another engine.
//!
//! Every upstream server up to v0.2.9 accepts exactly the keys below in
//! `clean_shared_defaults`; one unknown key makes it start with no shared
//! settings at all (upstream #4934). A copy written for such a server keeps
//! only these keys. A server that no longer rejects unknown keys gets the
//! bytes unchanged, and anything that does not parse is left as it is.

use serde_json::Value;
use std::path::Path;

pub const KNOWN_KEYS: [&str; 8] = [
    "reasoning_effort",
    "temperature",
    "top_p",
    "top_k",
    "seed",
    "max_tokens",
    "reasoning_budget_tokens",
    "experimental_speed_projection",
];

/// Whether the engine at `install_dir` drops all shared settings on an unknown
/// key. An unreadable server is treated as strict: every known release is.
pub fn rejects_unknown_keys(install_dir: &Path) -> bool {
    match std::fs::read_to_string(install_dir.join("serve/server.py")) {
        Ok(source) => source.contains("unknown setting"),
        Err(_) => true,
    }
}

/// Keeps only the keys a strict server accepts. Returns the removed keys.
pub fn retain_known(value: &mut Value) -> Vec<String> {
    let Some(object) = value.as_object_mut() else {
        return Vec::new();
    };
    let removed: Vec<String> = object
        .keys()
        .filter(|key| !KNOWN_KEYS.contains(&key.as_str()))
        .cloned()
        .collect();
    for key in &removed {
        object.remove(key);
    }
    removed
}

/// The bytes to write for the engine at `install_dir`.
pub fn fit_bytes(install_dir: &Path, bytes: &[u8]) -> Vec<u8> {
    if !rejects_unknown_keys(install_dir) {
        return bytes.to_vec();
    }
    let Ok(mut value) = serde_json::from_slice::<Value>(bytes) else {
        return bytes.to_vec();
    };
    if retain_known(&mut value).is_empty() {
        return bytes.to_vec();
    }
    serde_json::to_vec_pretty(&value).unwrap_or_else(|_| bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn engine(server: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(source) = server {
            fs::create_dir_all(dir.path().join("serve")).unwrap();
            fs::write(dir.path().join("serve/server.py"), source).unwrap();
        }
        dir
    }

    const STRICT: &str =
        "        else:\n            raise ValueError(f\"unknown setting {key!r}\")\n";

    #[test]
    fn strict_engine_keeps_only_the_eight_known_keys() {
        let dir = engine(Some(STRICT));
        let bytes = br#"{"temperature":0.6,"preserve_thinking":true,"top_k":20,"reasoning_budget_tokens":0}"#;
        let out: Value = serde_json::from_slice(&fit_bytes(dir.path(), bytes)).unwrap();
        assert_eq!(
            out,
            serde_json::json!({"temperature":0.6,"top_k":20,"reasoning_budget_tokens":0})
        );
    }

    #[test]
    fn known_keys_only_and_unparsable_files_stay_byte_for_byte() {
        let dir = engine(Some(STRICT));
        let known = b"{\"seed\": 7,  \"max_tokens\": 512}";
        assert_eq!(fit_bytes(dir.path(), known), known.to_vec());
        for raw in [&b"{not json"[..], b"[1,2]", b""] {
            assert_eq!(fit_bytes(dir.path(), raw), raw.to_vec());
        }
    }

    #[test]
    fn tolerant_engine_gets_new_keys_and_missing_server_counts_as_strict() {
        let bytes = br#"{"temperature":0.6,"preserve_thinking":true}"#;
        let tolerant = engine(Some("# unknown keys are skipped and logged\n"));
        assert_eq!(fit_bytes(tolerant.path(), bytes), bytes.to_vec());
        let missing = engine(None);
        let out: Value = serde_json::from_slice(&fit_bytes(missing.path(), bytes)).unwrap();
        assert_eq!(out, serde_json::json!({"temperature":0.6}));
    }

    #[test]
    fn allowlist_matches_upstream_clean_shared_defaults() {
        // Upstream v0.1.41..v0.2.9 serve/server.py, clean_shared_defaults.
        let mut keys = KNOWN_KEYS.to_vec();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "experimental_speed_projection",
                "max_tokens",
                "reasoning_budget_tokens",
                "reasoning_effort",
                "seed",
                "temperature",
                "top_k",
                "top_p"
            ]
        );
    }
}
