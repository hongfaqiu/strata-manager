//! One-time, per-profile migration of the previous local connection store.
//! This module never starts, loads, stops or downloads a model.
use crate::{types::ServiceProfile, RuntimeState};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Read, path::Path};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS legacy_profile_migrations(fingerprint TEXT PRIMARY KEY,outcome TEXT NOT NULL);";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationEntry {
    pub fingerprint: String,
    #[serde(default)]
    pub source_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub completed_at: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub schema_version: u32,
    pub imported: usize,
    pub failed: usize,
    pub ignored: usize,
    pub entries: Vec<MigrationEntry>,
}

fn fingerprint(source: &[u8]) -> String {
    format!("{:x}", Sha256::digest(source))
}

fn local_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    #[cfg(windows)]
    return matches!(path.components().next(),Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(),std::path::Prefix::Disk(_)|std::path::Prefix::VerbatimDisk(_)));
    #[cfg(not(windows))]
    true
}
fn asset_metadata(hash: &mut Sha256, path: &Path) {
    hash.update(path.to_string_lossy().as_bytes());
    if !local_path(path) {
        hash.update(b"non-local");
        return;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            hash.update(metadata.len().to_le_bytes());
            hash.update([
                u8::from(metadata.is_file()),
                u8::from(metadata.is_dir()),
                u8::from(metadata.file_type().is_symlink()),
            ]);
            if let Ok(modified) = metadata.modified().and_then(|time| {
                time.duration_since(std::time::UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            }) {
                hash.update(modified.as_nanos().to_le_bytes());
            }
        }
        Err(error) => hash.update(format!("missing:{:?}", error.kind()).as_bytes()),
    }
}

/// Source changes allow retry. Large models are checked by metadata only.
fn source_fingerprint(record: &Value) -> Result<(String, String), String> {
    let source = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let source_key = fingerprint(&source);
    let mut hash = Sha256::new();
    hash.update(&source);
    if let Ok(profile) = serde_json::from_value::<ServiceProfile>(record.clone()) {
        let config = Path::new(&profile.config_path);
        asset_metadata(&mut hash, Path::new(&profile.python_path));
        asset_metadata(&mut hash, config);
        if local_path(config)
            && fs::symlink_metadata(config).is_ok_and(|meta| {
                meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 4 * 1024 * 1024
            })
        {
            if let Ok(file) = fs::File::open(config) {
                let mut bytes = Vec::new();
                if file
                    .take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .is_ok()
                {
                    hash.update(&bytes);
                    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
                    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
                        let root = Path::new(&profile.install_dir);
                        let resolve = |base: &Path, path: &str| {
                            let path = Path::new(path);
                            if path.is_absolute() {
                                path.to_owned()
                            } else {
                                base.join(path)
                            }
                        };
                        let cwd = value
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(|path| resolve(root, path))
                            .unwrap_or_else(|| root.to_owned());
                        asset_metadata(&mut hash, &root.join("setup.py"));
                        asset_metadata(&mut hash, &root.join("serve/server.py"));
                        for key in ["exe", "tokenizer"] {
                            if let Some(path) = value.get(key).and_then(Value::as_str) {
                                let path = resolve(&cwd, path);
                                asset_metadata(&mut hash, &path);
                                if key == "tokenizer" {
                                    for file in ["vocab.json", "merges.txt", "token_type.json"] {
                                        asset_metadata(&mut hash, &path.join(file));
                                    }
                                }
                            }
                        }
                        if let Some(args) = value.get("args").and_then(Value::as_array) {
                            for pair in args.windows(2) {
                                if pair[0].as_str().is_some_and(|flag| {
                                    matches!(
                                        flag,
                                        "--native"
                                            | "--model"
                                            | "-m"
                                            | "--ple-gguf"
                                            | "--pack"
                                            | "--mtp"
                                            | "--expert-profile"
                                    )
                                }) {
                                    if let Some(path) = pair[1].as_str() {
                                        asset_metadata(&mut hash, &resolve(&cwd, path));
                                    }
                                }
                            }
                        }
                        if let Some(vision) = value.get("vision").and_then(Value::as_object) {
                            for key in ["exe", "model", "mmproj"] {
                                if let Some(path) = vision.get(key).and_then(Value::as_str) {
                                    asset_metadata(&mut hash, &resolve(&cwd, path));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok((source_key, format!("{:x}", hash.finalize())))
}

fn save(state: &RuntimeState, entry: &MigrationEntry) -> Result<(), String> {
    state.database.lock().map_err(|e| e.to_string())?.execute(
        "INSERT INTO legacy_profile_migrations(fingerprint,outcome) VALUES(?1,?2) ON CONFLICT(fingerprint) DO NOTHING",
        params![entry.fingerprint,serde_json::to_string(entry).map_err(|e|e.to_string())?],
    ).map_err(|e|e.to_string())?;
    Ok(())
}

fn seen(state: &RuntimeState, fingerprint: &str) -> Result<bool, String> {
    state
        .database
        .lock()
        .map_err(|e| e.to_string())?
        .query_row(
            "SELECT 1 FROM legacy_profile_migrations WHERE fingerprint=?1",
            [fingerprint],
            |row| row.get::<_, u8>(0),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|e| e.to_string())
}

/// Read durable diagnostics without re-probing paths or interpreters.
pub fn report(state: &RuntimeState) -> Result<MigrationReport, String> {
    let database = state.database.lock().map_err(|e| e.to_string())?;
    let mut query = database
        .prepare("SELECT outcome FROM legacy_profile_migrations ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let records = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut report = MigrationReport {
        schema_version: 1,
        ..MigrationReport::default()
    };
    let mut positions = HashMap::new();
    for record in records {
        let entry: MigrationEntry =
            serde_json::from_str(&record.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let source_key = if entry.source_key.is_empty() {
            entry.fingerprint.clone()
        } else {
            entry.source_key.clone()
        };
        if let Some(index) = positions.get(&source_key) {
            report.entries[*index] = entry;
        } else {
            positions.insert(source_key, report.entries.len());
            report.entries.push(entry);
        }
    }
    for entry in &report.entries {
        match entry.status.as_str() {
            "imported" => report.imported += 1,
            "failed" => report.failed += 1,
            _ => report.ignored += 1,
        }
    }
    Ok(report)
}

/// Each original record is processed independently and remains byte-for-byte
/// in `kv.profiles`. A stored result prevents repeated probes and snapshot writes
/// after reopen, including failed or deliberately removed legacy registrations.
pub fn migrate(state: &RuntimeState) -> Result<MigrationReport, String> {
    let _migration = state.legacy_migration.lock().map_err(|e| e.to_string())?;
    let raw: Option<String> = state
        .database
        .lock()
        .map_err(|e| e.to_string())?
        .query_row("SELECT value FROM kv WHERE key='profiles'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return report(state) };
    let records = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(records)) => records,
        Ok(Value::Null) => return report(state),
        _ => {
            let entry = MigrationEntry {
                fingerprint: fingerprint(raw.as_bytes()),
                source_key: "invalid-profiles-store".into(),
                id: None,
                name: None,
                status: "failed".into(),
                profile_id: None,
                reason: Some(
                    "旧版模型档案格式无效，已保留原数据；请在本机检测中重新确认安装".into(),
                ),
                completed_at: crate::types::now(),
            };
            save(state, &entry)?;
            return report(state);
        }
    };
    for (index, record) in records.into_iter().enumerate() {
        let (source_key, fingerprint) = source_fingerprint(&record)?;
        if seen(state, &fingerprint)? {
            continue;
        }
        let mut entry = MigrationEntry {
            fingerprint,
            source_key,
            id: record.get("id").and_then(Value::as_str).map(String::from),
            name: record
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name.chars().take(100).collect()),
            status: "failed".into(),
            profile_id: None,
            reason: None,
            completed_at: crate::types::now(),
        };
        let result = if index >= 256 {
            Err("旧版档案超过自动迁移的 256 项上限，已保留原数据".into())
        } else {
            migrate_record(state, record)
        };
        match result {
            Ok((profile, status)) => {
                entry.status = status.into();
                entry.profile_id = Some(profile.id);
            }
            Err(reason) => entry.reason = Some(reason),
        }
        save(state, &entry)?;
    }
    report(state)
}

fn migrate_record(
    state: &RuntimeState,
    record: Value,
) -> Result<(ServiceProfile, &'static str), String> {
    let profile: ServiceProfile = serde_json::from_value(record)
        .map_err(|_| "旧版模型档案字段不完整，已保留原数据".to_string())?;
    if profile.id.is_empty()
        || profile.id.len() > 80
        || !profile
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("旧版档案标识无效，未修改其聊天、凭据或原始配置".into());
    }
    if profile.name.chars().count() > 100 {
        return Err("旧版档案名称超过 100 个字符，未静默截断或覆盖原名称".into());
    }
    crate::external::local_port(&profile)
        .map_err(|_| "旧版档案不是本机 loopback 服务，未自动迁移".to_string())?;
    if let Some(registered) = state
        .registered_profiles()?
        .into_iter()
        .find(|p| p.id == profile.id)
    {
        let matches = state.original_profiles()?.iter().any(|original| {
            original.id == profile.id
                && same_path(&original.install_dir, &profile.install_dir)
                && same_path(&original.config_path, &profile.config_path)
        });
        if matches {
            return Ok((registered, "imported"));
        }
        return Err("旧档案标识已被另一款本机模型占用，未覆盖已有登记".into());
    }
    state.import_legacy_local(profile).map(|p| (p, "imported"))
}

fn same_path(left: &str, right: &str) -> bool {
    match (dunce::canonicalize(left), dunce::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put_raw(state: &RuntimeState, raw: &str) {
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO kv(key,value) VALUES('profiles',?1)",
                [raw],
            )
            .unwrap();
    }
    fn raw(state: &RuntimeState) -> String {
        state
            .database
            .lock()
            .unwrap()
            .query_row("SELECT value FROM kv WHERE key='profiles'", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
    #[test]
    fn malformed_records_are_durable_visible_and_do_not_block_the_registry() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        put_raw(
            &state,
            "[ {\"id\":\"missing-fields\",\"name\":\"保留档案\"},17 ]",
        );
        let original = raw(&state);
        let report = migrate(&state).unwrap();
        assert_eq!(report.failed, 2);
        assert!(report
            .entries
            .iter()
            .all(|entry| entry.reason.as_ref().unwrap().contains("保留")));
        assert_eq!(raw(&state), original);
        assert!(state.registered_profiles().unwrap().is_empty());
        let first = serde_json::to_value(&report).unwrap();
        drop(state);
        let reopened = RuntimeState::open(temp.path().into()).unwrap();
        assert_eq!(
            serde_json::to_value(migrate(&reopened).unwrap()).unwrap(),
            first
        );
        assert_eq!(raw(&reopened), original);
        put_raw(&reopened, "{broken-json");
        assert_eq!(migrate(&reopened).unwrap().failed, 3);
        assert_eq!(raw(&reopened), "{broken-json");
    }

    #[cfg(windows)]
    fn fixture(root: &Path) -> ServiceProfile {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("tokenizer")).unwrap();
        fs::write(root.join("setup.py"), "# never executed").unwrap();
        fs::write(root.join("serve/server.py"), "# never executed").unwrap();
        fs::write(root.join("tokenizer/vocab.json"), "{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), "").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), "[]").unwrap();
        fs::write(root.join("engine.exe"), "fixture, never executed").unwrap();
        fs::write(root.join("model.gguf"), "fixture, never loaded").unwrap();
        let python = crate::output(
            "py",
            &["-I", "-S", "-c", "import sys;print(sys.executable)"],
        )
        .unwrap();
        let config = root.join("strata-existing.json");
        fs::write(&config,serde_json::to_vec(&json!({"exe":"engine.exe","args":["--native","model.gguf"],"cwd":root,"tokenizer":"tokenizer","model_name":"actual-config-name","port":port,"custom":{"preserve":true}})).unwrap()).unwrap();
        ServiceProfile {
            id: format!("legacy-{}", uuid::Uuid::new_v4()),
            name: "我已有的模型".into(),
            base_url: format!("http://localhost:{port}"),
            install_dir: root.to_string_lossy().into(),
            python_path: python,
            config_path: config.to_string_lossy().into(),
            managed: false,
        }
    }

    #[cfg(windows)]
    #[test]
    fn local_profiles_keep_identity_credentials_history_and_exact_sources_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let profile = fixture(&temp.path().join("strata"));
        let source = fs::read(&profile.config_path).unwrap();
        let mut broken = profile.clone();
        broken.id = format!("missing-{}", uuid::Uuid::new_v4());
        broken.config_path = temp.path().join("missing.json").to_string_lossy().into();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let original =
            serde_json::to_string_pretty(&json!([profile,broken,{"id":"bad-record"}])).unwrap();
        put_raw(&state, &original);
        let history = json!([{"id":"old-conversation","profileId":profile.id,"messages":[]}]);
        crate::store_set(&state, "conversations".into(), history.clone()).unwrap();
        let options = json!({profile.id.clone():{"temperature":0.4}});
        crate::store_set(&state, "chatOptionsByProfile".into(), options.clone()).unwrap();
        crate::set_api_key(profile.id.clone(), "isolated-old-profile-test-key".into()).unwrap();
        struct KeyCleanup(String);
        impl Drop for KeyCleanup {
            fn drop(&mut self) {
                let _ = crate::set_api_key(self.0.clone(), String::new());
            }
        }
        let _key = KeyCleanup(profile.id.clone());
        let report = migrate(&state).unwrap();
        assert_eq!((report.imported, report.failed), (1, 2));
        let registered = state.registered_profiles().unwrap().pop().unwrap();
        assert_eq!(registered.id, profile.id);
        assert_eq!(registered.name, profile.name);
        assert_eq!(
            registered.python_path,
            dunce::canonicalize(&profile.python_path)
                .unwrap()
                .to_string_lossy()
        );
        assert!(registered.managed);
        assert_ne!(registered.config_path, profile.config_path);
        assert_eq!(raw(&state), original);
        assert_eq!(fs::read(&profile.config_path).unwrap(), source);
        assert_eq!(
            crate::store_get(&state, "conversations".into()).unwrap(),
            history
        );
        assert_eq!(
            crate::store_get(&state, "chatOptionsByProfile".into()).unwrap(),
            options
        );
        assert_eq!(
            crate::http::key(&profile.id).unwrap().as_deref(),
            Some("isolated-old-profile-test-key")
        );
        assert!(state.processes.lock().unwrap().is_empty());
        assert!(state.tasks.lock().unwrap().is_empty());
        let snapshot = fs::read(&registered.config_path).unwrap();
        let modified = fs::metadata(&registered.config_path)
            .unwrap()
            .modified()
            .unwrap();
        let first = serde_json::to_value(&report).unwrap();
        drop(state);
        let reopened = RuntimeState::open(temp.path().join("state")).unwrap();
        assert_eq!(
            serde_json::to_value(migrate(&reopened).unwrap()).unwrap(),
            first
        );
        assert_eq!(fs::read(&registered.config_path).unwrap(), snapshot);
        assert_eq!(
            fs::metadata(&registered.config_path)
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        assert_eq!(raw(&reopened), original);
        assert!(reopened.processes.lock().unwrap().is_empty());
        reopened.remove_local_installation(profile.id).unwrap();
        migrate(&reopened).unwrap();
        assert!(reopened.registered_profiles().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn repaired_config_and_missing_asset_retry_without_profile_edits() {
        let temp = tempfile::tempdir().unwrap();
        let profile = fixture(&temp.path().join("strata"));
        let valid = fs::read(&profile.config_path).unwrap();
        fs::write(&profile.config_path, "{invalid}").unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let original = serde_json::to_string(&json!([profile])).unwrap();
        put_raw(&state, &original);
        assert_eq!(migrate(&state).unwrap().failed, 1);
        let first = serde_json::to_value(migrate(&state).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(migrate(&state).unwrap()).unwrap(),
            first
        );
        fs::write(&profile.config_path, &valid).unwrap();
        fs::remove_file(Path::new(&profile.install_dir).join("model.gguf")).unwrap();
        assert_eq!(migrate(&state).unwrap().failed, 1);
        fs::write(
            Path::new(&profile.install_dir).join("model.gguf"),
            "repaired existing model",
        )
        .unwrap();
        let report = migrate(&state).unwrap();
        assert_eq!(
            (report.imported, report.failed, report.entries.len()),
            (1, 0, 1)
        );
        assert_eq!(state.registered_profiles().unwrap()[0].id, profile.id);
        assert_eq!(raw(&state), original);
        assert_eq!(fs::read(&profile.config_path).unwrap(), valid);
        assert!(state.processes.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn conflicting_legacy_identity_never_overwrites_an_existing_registration() {
        let temp = tempfile::tempdir().unwrap();
        let profile = fixture(&temp.path().join("first"));
        let mut other = fixture(&temp.path().join("second"));
        other.id = profile.id.clone();
        other.name = "不能覆盖的重名档案".into();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        put_raw(&state, &serde_json::to_string(&json!([profile])).unwrap());
        assert_eq!(migrate(&state).unwrap().imported, 1);
        let before = serde_json::to_value(state.registered_profiles().unwrap()).unwrap();
        let raw_value = serde_json::to_string(&json!([profile, other])).unwrap();
        put_raw(&state, &raw_value);
        let report = migrate(&state).unwrap();
        assert_eq!((report.imported, report.failed), (1, 1));
        assert!(report.entries.iter().any(|entry| entry
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("未覆盖"))));
        assert_eq!(
            serde_json::to_value(state.registered_profiles().unwrap()).unwrap(),
            before
        );
        assert_eq!(raw(&state), raw_value);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn running_venv_wrapper_is_registered_without_loading_or_stopping_its_global_python_child(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let mut profile = fixture(&temp.path().join("strata"));
        let root = Path::new(&profile.install_dir);
        let mut command = std::process::Command::new(&profile.python_path);
        command
            .args(["-m", "venv", "--without-pip"])
            .arg(root.join(".venv"));
        crate::processes::hidden(&mut command);
        assert!(command.status().unwrap().success());
        profile.python_path = root
            .join(".venv/Scripts/python.exe")
            .to_string_lossy()
            .into();
        let port = crate::external::local_port(&profile).unwrap();
        fs::write(root.join("serve/server.py"),r#"from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import argparse,json
p=argparse.ArgumentParser();p.add_argument('--port',type=int);args,_=p.parse_known_args()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  body=json.dumps({'status':'ok','service':'strata','loaded':True}).encode();self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_POST(self):
  print('UNEXPECTED_MODEL_MUTATION',flush=True);self.send_error(500)
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
"#).unwrap();
        let source = fs::read(&profile.config_path).unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let mut command = std::process::Command::new(&profile.python_path);
        command
            .current_dir(root)
            .args(["-u", "-m", "serve.server", "--engine", "strata", "--config"])
            .arg(&profile.config_path)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()]);
        let mut external = crate::processes::OwnedProcess::spawn(
            command,
            state.logs.clone(),
            "legacy-source-only",
        )
        .unwrap();
        for _ in 0..100 {
            if crate::external::port_accepting(&profile).unwrap() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let original = crate::external::detect(&profile).unwrap().unwrap();
        put_raw(&state, &serde_json::to_string(&json!([profile])).unwrap());
        let report = migrate(&state).unwrap();
        assert_eq!((report.imported, report.failed), (1, 0));
        let after = crate::external::detect(&profile).unwrap().unwrap();
        assert_eq!((after.pid, after.created), (original.pid, original.created));
        assert!(external.refresh().unwrap().running);
        assert_eq!(
            state.registered_profiles().unwrap()[0].base_url,
            format!("http://127.0.0.1:{port}")
        );
        assert_eq!(fs::read(&profile.config_path).unwrap(), source);
        assert!(state.processes.lock().unwrap().is_empty());
        assert!(!state
            .logs
            .lock()
            .unwrap()
            .values()
            .flatten()
            .any(|line| line.message.contains("UNEXPECTED_MODEL_MUTATION")));
        external.stop().unwrap();
    }
}
