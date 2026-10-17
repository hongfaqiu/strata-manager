//! Read-only plan for removing older Strata versions' run configurations.
//!
//! Upstream keeps one `strata-<model>.json` in every installed version's folder
//! while all versions share the model files in `Strata-data`. The plan lists
//! only those per-version JSON files. It never lists model shards, MTP layers,
//! packs, Chat shared-settings, anything in a shared data folder, the current
//! installation's files, a running configuration or a registered one. Deletion
//! is a separate, per-file `delete_configuration` call that archives the file.
use crate::configuration_files::path_key;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};
use strata_runtime_core::types::ServiceProfile;

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ITEMS: usize = 256;
const DATA_DIRECTORIES: [&str; 3] = ["models", "packs", "mtp"];
const PATH_KEYS: [&str; 5] = ["exe", "cwd", "log", "tokenizer", "lib_dirs"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    /// The identity to pass to `delete_configuration` for this file.
    pub profile: ServiceProfile,
    pub config_path: String,
    pub install_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    /// Same settings as a configuration of the current installation.
    pub identical: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identical_to: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPlan {
    pub current_install_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    pub items: Vec<CleanupItem>,
}

/// Discovery records plus everything that must never be offered for removal.
pub struct CleanupInput<'a> {
    pub candidates: &'a [Value],
    pub registered: &'a [ServiceProfile],
    /// Original paths of registered private copies.
    pub protected_paths: &'a [PathBuf],
    pub current_install_dir: &'a Path,
}

fn is_runtime_root(root: &Path) -> bool {
    root.join("setup.py").is_file() && root.join("serve/server.py").is_file()
}

/// Upstream's own pattern: `strata-*.json`, excluding Chat shared-settings.
pub(crate) fn is_run_config_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with("strata-")
                && lower.ends_with(".json")
                && !lower.ends_with(".shared-settings.json")
        })
}

/// The file sits directly in the installation folder or its `configs/`, and no
/// path component is a model-data folder.
fn inside_installation(config: &Path, install: &Path) -> bool {
    let Ok(relative) = config.strip_prefix(install) else {
        return false;
    };
    let parts: Vec<_> = relative.components().collect();
    let parent_ok = match parts.as_slice() {
        [Component::Normal(_)] => true,
        [Component::Normal(folder), Component::Normal(_)] => {
            folder.to_string_lossy().eq_ignore_ascii_case("configs")
        }
        _ => false,
    };
    parent_ok
        && !relative.components().any(|part| {
            DATA_DIRECTORIES.iter().any(|data| {
                part.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(data)
            })
        })
}

fn read_config(path: &Path) -> Option<Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let runnable = value
        .get("exe")
        .and_then(Value::as_str)
        .is_some_and(|exe| !exe.is_empty())
        && value.get("args").is_some_and(Value::is_array);
    runnable.then_some(value)
}

fn slashes(text: &str) -> String {
    let text = text.replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// Settings identity with installation-local paths written as `<install>/…`.
pub(crate) fn fingerprint(config: &Value, install: &Path) -> String {
    // Both the resolved and the written form of the folder count as local.
    let mut roots: Vec<String> = [path_key(install), install.to_string_lossy().into_owned()]
        .iter()
        .map(|root| slashes(root).trim_end_matches('/').to_owned())
        .collect();
    roots.dedup();
    fn walk(value: &Value, roots: &[String], path_field: bool) -> Value {
        match value {
            Value::String(text) => {
                if Path::new(text).is_absolute() || text.starts_with('/') {
                    let key = slashes(text);
                    for root in roots {
                        if key == *root {
                            return Value::String("<install>".into());
                        }
                        if let Some(rest) = key.strip_prefix(&format!("{root}/")) {
                            return Value::String(format!("<install>/{rest}"));
                        }
                    }
                    return Value::String(key);
                }
                if path_field {
                    let relative = text.replace('\\', "/");
                    return Value::String(format!(
                        "<install>/{}",
                        relative.trim_start_matches("./")
                    ));
                }
                value.clone()
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| walk(item, roots, path_field))
                    .collect(),
            ),
            Value::Object(object) => {
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort();
                let mut sorted = serde_json::Map::new();
                for key in keys {
                    sorted.insert(
                        key.clone(),
                        walk(&object[key], roots, PATH_KEYS.contains(&key.as_str())),
                    );
                }
                Value::Object(sorted)
            }
            other => other.clone(),
        }
    }
    walk(config, &roots, false).to_string()
}

fn current_fingerprints(input: &CleanupInput) -> Vec<(String, String)> {
    let current = input.current_install_dir;
    let mut paths = Vec::new();
    for directory in [current.to_path_buf(), current.join("configs")] {
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.take(MAX_ITEMS).flatten() {
                let path = entry.path();
                if is_run_config_name(&path) {
                    paths.push(path);
                }
            }
        }
    }
    let current_key = path_key(current);
    for profile in input.registered {
        if path_key(Path::new(&profile.install_dir)) == current_key {
            paths.push(PathBuf::from(&profile.config_path));
        }
    }
    paths
        .into_iter()
        .filter_map(|path| {
            read_config(&path)
                .map(|config| (fingerprint(&config, current), path.to_string_lossy().into()))
        })
        .collect()
}

pub fn plan(input: CleanupInput) -> Result<CleanupPlan, String> {
    let current = dunce::canonicalize(input.current_install_dir)
        .map_err(|e| format!("当前运行环境目录不可用 / Current runtime folder unavailable: {e}"))?;
    if !is_runtime_root(&current) {
        return Err(
            "当前目录不是 Strata 运行环境 / The current folder is not a Strata runtime".into(),
        );
    }
    let input = CleanupInput {
        current_install_dir: &current,
        ..input
    };
    let current_key = path_key(&current);
    let mut protected: HashSet<String> = input
        .registered
        .iter()
        .map(|profile| path_key(Path::new(&profile.config_path)))
        .collect();
    protected.extend(input.protected_paths.iter().map(|path| path_key(path)));
    for candidate in input.candidates {
        if candidate["running"].as_bool() == Some(true) {
            if let Some(path) = candidate["configPath"].as_str() {
                protected.insert(path_key(Path::new(path)));
            }
        }
    }
    let current_prints = current_fingerprints(&input);
    let mut current_version = None;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for candidate in input.candidates {
        let (Some(config_path), Some(install_dir)) = (
            candidate["configPath"].as_str(),
            candidate["installDir"].as_str(),
        ) else {
            continue;
        };
        let Ok(install) = dunce::canonicalize(install_dir) else {
            continue;
        };
        if path_key(&install) == current_key {
            current_version =
                current_version.or(candidate["runtimeVersion"].as_str().map(str::to_owned));
            continue;
        }
        let raw = Path::new(config_path);
        if raw.is_symlink() || !is_run_config_name(raw) {
            continue;
        }
        let Ok(config) = dunce::canonicalize(raw) else {
            continue;
        };
        let key = path_key(&config);
        if protected.contains(&key)
            || !seen.insert(key)
            || config.starts_with(&current)
            || !is_runtime_root(&install)
            || !inside_installation(&config, &install)
        {
            continue;
        }
        let Some(value) = read_config(&config) else {
            continue;
        };
        let print = fingerprint(&value, &install);
        let identical_to = current_prints
            .iter()
            .find(|(other, _)| *other == print)
            .map(|(_, path)| path.clone());
        let id = candidate["id"].as_str().unwrap_or("cleanup");
        let port = candidate["detectedPort"].as_u64().unwrap_or(8080);
        items.push(CleanupItem {
            profile: ServiceProfile {
                id: format!("configuration-{id}"),
                name: candidate["name"].as_str().unwrap_or_default().to_owned(),
                base_url: format!("http://127.0.0.1:{port}"),
                install_dir: install.to_string_lossy().into(),
                python_path: candidate["pythonPath"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                config_path: config.to_string_lossy().into(),
                managed: false,
            },
            config_path: config.to_string_lossy().into(),
            install_dir: install.to_string_lossy().into(),
            runtime_version: candidate["runtimeVersion"].as_str().map(str::to_owned),
            model_name: value
                .get("model_name")
                .and_then(Value::as_str)
                .map(str::to_owned),
            identical: identical_to.is_some(),
            identical_to,
        });
        if items.len() >= MAX_ITEMS {
            break;
        }
    }
    items.sort_by(|a, b| {
        b.identical
            .cmp(&a.identical)
            .then_with(|| a.install_dir.cmp(&b.install_dir))
            .then_with(|| a.config_path.cmp(&b.config_path))
    });
    Ok(CleanupPlan {
        current_install_dir: current.to_string_lossy().into(),
        current_version,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn install(root: &Path) {
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
    }

    fn config(root: &Path, data: &Path, context: &str) -> Value {
        json!({
            "exe": root.join("engine/strata.exe"), "cwd": root, "log": "strata-qwen.log", "model_name": "Qwen",
            "args": ["--native", data.join("models/Qwen-00001-of-00002.gguf"), "--mtp", data.join("mtp/qwen-mtp.gguf"), "--max-context", context],
        })
    }

    fn write(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn candidate(id: &str, root: &Path, config: &Path, version: &str) -> Value {
        json!({"id": id, "name": id, "installDir": root, "configPath": config, "pythonPath": "", "runtimeVersion": version, "running": false})
    }

    struct Layout {
        _temp: tempfile::TempDir,
        data: PathBuf,
        old: PathBuf,
        older: PathBuf,
        current: PathBuf,
    }

    fn layout() -> Layout {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("Strata-data");
        let [older, old, current] =
            ["0.1.38", "0.1.42", "0.1.44"].map(|v| temp.path().join(format!("Strata-{v}")));
        for root in [&older, &old, &current] {
            install(root);
        }
        fs::create_dir_all(data.join("models")).unwrap();
        fs::create_dir_all(data.join("mtp")).unwrap();
        fs::write(data.join("models/Qwen-00001-of-00002.gguf"), b"shard").unwrap();
        fs::write(data.join("mtp/qwen-mtp.gguf"), b"mtp").unwrap();
        write(
            &current.join("strata-qwen.json"),
            &config(&current, &data, "65536"),
        );
        write(&old.join("strata-qwen.json"), &config(&old, &data, "65536"));
        write(
            &older.join("strata-qwen.json"),
            &config(&older, &data, "32768"),
        );
        Layout {
            data,
            old,
            older,
            current,
            _temp: temp,
        }
    }

    fn run(layout: &Layout, candidates: &[Value], registered: &[ServiceProfile]) -> CleanupPlan {
        plan(CleanupInput {
            candidates,
            registered,
            protected_paths: &[],
            current_install_dir: &layout.current,
        })
        .unwrap()
    }

    fn listed(plan: &CleanupPlan) -> Vec<String> {
        plan.items
            .iter()
            .map(|item| path_key(Path::new(&item.config_path)))
            .collect()
    }

    #[test]
    fn lists_only_older_versions_and_marks_identical_copies() {
        let l = layout();
        let candidates = [
            candidate(
                "current",
                &l.current,
                &l.current.join("strata-qwen.json"),
                "0.1.44",
            ),
            candidate("old", &l.old, &l.old.join("strata-qwen.json"), "0.1.42"),
            candidate(
                "older",
                &l.older,
                &l.older.join("strata-qwen.json"),
                "0.1.38",
            ),
        ];
        let plan = run(&l, &candidates, &[]);
        assert_eq!(plan.current_version.as_deref(), Some("0.1.44"));
        assert_eq!(plan.items.len(), 2);
        assert!(plan.items[0].identical, "0.1.42 matches the current copy");
        assert_eq!(plan.items[0].runtime_version.as_deref(), Some("0.1.42"));
        assert!(!plan.items[1].identical, "0.1.38 has another context");
        assert_eq!(plan.items[1].profile.config_path, plan.items[1].config_path);
        assert!(!plan.items[1].profile.managed);
        assert!(!listed(&plan).contains(&path_key(&l.current.join("strata-qwen.json"))));
    }

    #[test]
    fn never_lists_shards_mtp_packs_shared_settings_or_data_folder_configs() {
        let l = layout();
        let shared = l.old.join("strata-qwen.shared-settings.json");
        write(&shared, &json!({"exe": "x", "args": []}));
        let in_models = l.old.join("models/strata-weights.json");
        write(&in_models, &config(&l.old, &l.data, "1"));
        let in_mtp = l.old.join("mtp/strata-mtp.json");
        write(&in_mtp, &config(&l.old, &l.data, "1"));
        let in_packs = l.old.join("configs/packs/strata-pack.json");
        write(&in_packs, &config(&l.old, &l.data, "1"));
        let in_data = l.data.join("strata-from-data.json");
        write(&in_data, &config(&l.old, &l.data, "1"));
        let other_json = l.old.join("settings.json");
        write(&other_json, &config(&l.old, &l.data, "1"));
        let candidates = [
            candidate(
                "shard",
                &l.old,
                &l.data.join("models/Qwen-00001-of-00002.gguf"),
                "0.1.42",
            ),
            candidate("mtp", &l.old, &l.data.join("mtp/qwen-mtp.gguf"), "0.1.42"),
            candidate("shared", &l.old, &shared, "0.1.42"),
            candidate("models", &l.old, &in_models, "0.1.42"),
            candidate("mtp-dir", &l.old, &in_mtp, "0.1.42"),
            candidate("packs", &l.old, &in_packs, "0.1.42"),
            candidate("data", &l.old, &in_data, "0.1.42"),
            candidate("data-install", &l.data, &in_data, "0.1.42"),
            candidate("other", &l.old, &other_json, "0.1.42"),
        ];
        let plan = run(&l, &candidates, &[]);
        assert!(plan.items.is_empty(), "{:?}", listed(&plan));
        assert!(l.data.join("models/Qwen-00001-of-00002.gguf").is_file());
    }

    #[test]
    fn never_lists_running_registered_or_imported_source_configurations() {
        let l = layout();
        let older = l.older.join("strata-qwen.json");
        let old = l.old.join("strata-qwen.json");
        let mut running = candidate("running", &l.older, &older, "0.1.38");
        running["running"] = json!(true);
        let registered = ServiceProfile {
            id: "saved".into(),
            name: "saved".into(),
            base_url: "http://127.0.0.1:8080".into(),
            install_dir: l.old.to_string_lossy().into(),
            python_path: String::new(),
            config_path: old.to_string_lossy().into(),
            managed: true,
        };
        let plan = run(
            &l,
            &[running, candidate("old", &l.old, &old, "0.1.42")],
            &[registered],
        );
        assert!(plan.items.is_empty(), "{:?}", listed(&plan));

        let imported = plan_with_protected(
            &l,
            &[candidate("old", &l.old, &old, "0.1.42")],
            std::slice::from_ref(&old),
        );
        assert!(imported.items.is_empty());
    }

    fn plan_with_protected(l: &Layout, candidates: &[Value], protected: &[PathBuf]) -> CleanupPlan {
        plan(CleanupInput {
            candidates,
            registered: &[],
            protected_paths: protected,
            current_install_dir: &l.current,
        })
        .unwrap()
    }

    #[test]
    fn rejects_a_current_folder_that_is_not_a_runtime_and_skips_invalid_json() {
        let l = layout();
        assert!(plan(CleanupInput {
            candidates: &[],
            registered: &[],
            protected_paths: &[],
            current_install_dir: &l.data,
        })
        .is_err());
        let broken = l.old.join("strata-broken.json");
        fs::write(&broken, b"{").unwrap();
        let no_args = l.old.join("strata-no-args.json");
        write(&no_args, &json!({"exe": "strata.exe"}));
        let plan = run(
            &l,
            &[
                candidate("broken", &l.old, &broken, "0.1.42"),
                candidate("no-args", &l.old, &no_args, "0.1.42"),
            ],
            &[],
        );
        assert!(plan.items.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlinked_configuration() {
        let l = layout();
        let link = l.old.join("strata-link.json");
        std::os::unix::fs::symlink(l.current.join("strata-qwen.json"), &link).unwrap();
        let plan = run(&l, &[candidate("link", &l.old, &link, "0.1.42")], &[]);
        assert!(plan.items.is_empty());
    }

    #[test]
    fn fingerprint_ignores_install_folder_but_keeps_shared_weights() {
        let l = layout();
        let current = fingerprint(&config(&l.current, &l.data, "1"), &l.current);
        let old = fingerprint(&config(&l.old, &l.data, "1"), &l.old);
        assert_eq!(current, old);
        let other_data = l.old.join("Strata-data");
        assert_ne!(
            current,
            fingerprint(&config(&l.old, &other_data, "1"), &l.old)
        );
    }
}
