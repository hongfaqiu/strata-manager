//! Bounded, read-only provenance. Model metadata is weak identity, never a verified content digest.
use crate::{storage, types::ServiceProfile, RuntimeState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::UNIX_EPOCH};

fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}
fn metadata(path: &Path) -> Option<Value> {
    let m = fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    Some(
        json!({"name":path.file_name()?.to_string_lossy(),"size":m.len(),"modifiedAt":m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis().to_string()}),
    )
}
fn option(args: &[String], names: &[&str]) -> Option<String> {
    let mut values = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        for name in names {
            if arg == name {
                values.push(args.get(index + 1)?.clone());
            } else if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                values.push(value.to_owned());
            }
        }
    }
    if values.len() == 1 && !values[0].is_empty() && !values[0].starts_with('-') {
        values.pop()
    } else {
        None
    }
}
fn basename(value: &str) -> Option<&str> {
    let name = value.rsplit(['/', '\\']).next()?;
    if name.is_empty() || matches!(name, "." | "..") || name.chars().any(char::is_control) {
        None
    } else {
        Some(name)
    }
}
/// Export a narrowly allowed recipe, never paths, shell operands, environment variables, request text or credentials.
fn resource_configuration(args: &[String]) -> Option<Value> {
    for names in [
        &["--max-context"][..],
        &["--native", "--model", "-m"],
        &["--pack"],
        &["--kv"],
        &["--gpu"],
        &["--batch", "--slots"],
        &["--layer-split"],
        &["--peer-device"],
        &["--resident-budget-gib"],
        &["--kv-resident"],
        &["--expert-cache"],
        &["--vram-reserve-mib"],
        &["--experts"],
    ] {
        let present = args.iter().any(|arg| {
            names
                .iter()
                .any(|name| arg == name || arg.starts_with(&format!("{name}=")))
        });
        if present && option(args, names).is_none() {
            return None;
        }
    }
    let context = option(args, &["--max-context"])?;
    context
        .parse::<u64>()
        .ok()
        .filter(|value| (512..=1_048_576).contains(value))?;
    let mut safe = vec!["--max-context".to_owned(), context];
    // DeepSeek-V4.1-Flash (arch deepseek41) names its model by the --pack folder only.
    let model = option(args, &["--native", "--model", "-m"]);
    if model.is_none() && option(args, &["--pack"]).is_none() {
        return None;
    }
    if let Some(model) = model {
        safe.extend(["--native".into(), basename(&model)?.to_owned()]);
    }
    if let Some(pack) = option(args, &["--pack"]) {
        safe.extend(["--pack".into(), basename(&pack)?.to_owned()]);
    }
    if let Some(kv) = option(args, &["--kv"]) {
        if !kv
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return None;
        }
        safe.extend(["--kv".into(), kv]);
    }
    // Preserve unsupported resource modes so the frontend cannot treat a custom mode as setup defaults.
    for flag in [
        "--layer-split",
        "--peer-device",
        "--resident-budget-gib",
        "--kv-resident",
        "--expert-cache",
        "--vram-reserve-mib",
        // Benchmark Arena compares these launch parameters within a model + quant group.
        "--pool-workers",
        "--pcie-frac",
        // DeepSeek-V4.1 speed choice (5 fast / 6 full quality): a different answer path, so a different benchmark group.
        "--experts",
        "--tp",
    ] {
        if let Some(value) = option(args, &[flag]) {
            if value.len() > 64
                || !value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b',' | b'-')
                })
            {
                return None;
            }
            safe.extend([flag.into(), value]);
        }
    }
    for flag in ["--resident-experts", "--mmap-experts", "--vram-elastic"] {
        if let Some(index) = args.iter().position(|arg| arg == flag) {
            safe.push(flag.into());
            // The DeepSeek engine takes `--mmap-experts auto|off|on`; Qwen's is a bare switch.
            if let Some(value) = args
                .get(index + 1)
                .filter(|value| matches!(value.as_str(), "auto" | "off" | "on"))
            {
                safe.push(value.clone());
            }
        }
    }
    let parallel = option(args, &["--batch", "--slots"])
        .map(|value| value.parse::<u32>())
        .transpose()
        .ok()?
        .unwrap_or(1);
    if !(1..=64).contains(&parallel) {
        return None;
    }
    let mut result = json!({"args":safe,"parallel":parallel});
    if args.iter().any(|arg| arg == "--vision") {
        result["vision"] = json!(true);
    }
    if let Some(gpu) = option(args, &["--gpu"]) {
        let ids = gpu
            .split(',')
            .map(|part| part.parse::<u32>())
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        if ids.is_empty() || ids.len() > 8 || ids.iter().any(|id| *id > 255) {
            return None;
        }
        result["gpu"] = json!(ids);
    }
    Some(result)
}
pub fn capture(state: &RuntimeState, profile: &ServiceProfile) -> Result<Value, String> {
    let owned = state.owned_gui_profile(&profile.id)?;
    if owned.config_path != profile.config_path {
        return Err("运行配置身份已改变".into());
    }
    let mut config = storage::read(&owned)?;
    let saved_cwd = config["cwd"]
        .as_str()
        .unwrap_or(&owned.install_dir)
        .to_owned();
    let saved_args: Vec<String> = config["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let startup = crate::chat_runtime::verified_startup(state, &profile.id).ok();
    let args = startup
        .as_ref()
        .map(|startup| startup.args.as_slice())
        .unwrap_or(&saved_args);
    let cwd = startup
        .as_ref()
        .and_then(|startup| startup.working_directory.as_deref())
        .unwrap_or_else(|| Path::new(&saved_cwd));
    let model = option(args, &["--native", "--model", "-m"]).or_else(|| option(args, &["--pack"]));
    let mut files = Vec::new();
    if let Some(model) = model {
        let p = Path::new(&model);
        let path = if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        };
        if let Some(m) = metadata(&path) {
            files.push(m);
        } else if path.is_dir() {
            let mut paths: Vec<_> = fs::read_dir(path)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .collect();
            paths.sort();
            for path in paths.into_iter().take(256) {
                if path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| ["gguf", "safetensors", "bin"].contains(&s))
                    .unwrap_or(false)
                {
                    if let Some(m) = metadata(&path) {
                        files.push(m);
                    }
                }
            }
        }
    }
    let runtime = startup
        .as_ref()
        .and_then(|startup| metadata(&startup.executable))
        .or_else(|| {
            config["exe"]
                .as_str()
                .map(|exe| {
                    let p = Path::new(exe);
                    if p.is_absolute() {
                        p.to_path_buf()
                    } else {
                        cwd.join(p)
                    }
                })
                .and_then(|p| metadata(&p))
        });
    let process = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&profile.id)
        .map(|p| p.refresh())
        .transpose()?
        .unwrap_or_default();
    storage::redact(&mut config);
    let resident = crate::chat_runtime::evidence(state, &profile.id)?;
    let resource_configuration = startup
        .as_ref()
        .and_then(|startup| resource_configuration(&startup.args));
    let effective_hash = startup.as_ref().map(|startup| digest(&json!(startup.args)));
    let hardware_signature = crate::resource_assessment::hardware_signature(state)?;
    let engine_process = startup
        .as_ref()
        .map(|s| json!({"pid":s.pid,"startedAt":s.started_at}));
    Ok(
        json!({"schemaVersion":1,"capturedAt":crate::now(),"process":{"pid":process.pid,"startedAt":process.started_at,"running":process.running},"runtime":{"strength":if runtime.is_some(){"metadata"}else{"unknown"},"fingerprint":runtime.as_ref().map(digest)},"model":{"strength":if files.is_empty(){"unknown"}else{"metadata"},"fingerprint":if files.is_empty(){None}else{Some(digest(&json!(files)))},"files":files},"savedConfigurationHash":digest(&config),"effectiveStartupHash":effective_hash,"effectiveVerified":startup.is_some(),"residentEvidence":resident,"resourceConfiguration":resource_configuration,"hardwareSignature":hardware_signature,"engineProcess":engine_process}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_digest_is_not_a_content_digest() {
        assert_eq!(digest(&json!({"a":1})), digest(&json!({"a":1})));
        assert_ne!(digest(&json!({"a":1})), digest(&json!({"a":2})));
        assert!(metadata(Path::new("missing-model-file.gguf")).is_none());
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[test]
    fn recipe_export_drops_paths_credentials_and_prompt_text_without_inventing_cache_depth() {
        let args = [
            "strata",
            "--native",
            "D:\\private\\Qwen3.8-IQ3_S.gguf",
            "--max-context",
            "131072",
            "--kv",
            "int8",
            "--api-key",
            "secret-fixture",
            "--prompt",
            "sensitive prompt",
            "--gpu",
            "0",
            "--batch",
            "2",
        ]
        .map(str::to_owned);
        let result = resource_configuration(&args).unwrap();
        let text = result.to_string();
        assert!(!text.contains("private"));
        assert!(!text.contains("secret-fixture"));
        assert!(!text.contains("sensitive"));
        assert!(!text.contains("prompt-cache"));
        assert_eq!(result["parallel"], 2);
        assert_eq!(result["gpu"], json!([0]));
        assert!(text.contains("Qwen3.8-IQ3_S.gguf"));
    }
    #[test]
    fn engine_slot_count_comes_from_the_effective_engine_args() {
        // serve/server.py turns "parallel": N into --batch N on the engine command line; --slots is the alias.
        let base = [
            "strata",
            "--native",
            "/m/Qwen3.8-IQ3_S.gguf",
            "--max-context",
            "32768",
        ];
        let with = |extra: &[&str]| {
            base.iter()
                .chain(extra.iter())
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(resource_configuration(&with(&[])).unwrap()["parallel"], 1);
        assert_eq!(
            resource_configuration(&with(&["--slots", "4"])).unwrap()["parallel"],
            4
        );
        assert_eq!(
            resource_configuration(&with(&["--batch=8"])).unwrap()["parallel"],
            8
        );
        assert!(resource_configuration(&with(&["--batch", "65"])).is_none());
        assert!(resource_configuration(&with(&["--batch", "two"])).is_none());
        let text = resource_configuration(&with(&[
            "--batch",
            "4",
            "--batch-mtp",
            "--batch-groups",
            "2",
        ]))
        .unwrap()
        .to_string();
        assert!(
            !text.contains("batch-groups"),
            "only whitelisted recipe flags are exported"
        );
    }
    #[test]
    fn deepseek41_identity_keeps_the_pack_the_speed_choice_and_the_load_mode() {
        let base = [
            "--pack",
            "/models/packs/deepseek-v4.1-flash-ist-das-2.00bpw",
            "--max-context",
            "8192",
            "--eos",
            "1",
            "--dspark",
            "auto",
        ]
        .map(String::from)
        .to_vec();
        let plain = resource_configuration(&base).unwrap();
        assert_eq!(
            plain["args"],
            json!([
                "--max-context",
                "8192",
                "--pack",
                "deepseek-v4.1-flash-ist-das-2.00bpw"
            ])
        );
        let mut fast = base.clone();
        fast.extend(["--experts", "5", "--mmap-experts", "on"].map(String::from));
        let fast = resource_configuration(&fast).unwrap();
        assert_eq!(
            fast["args"],
            json!([
                "--max-context",
                "8192",
                "--pack",
                "deepseek-v4.1-flash-ist-das-2.00bpw",
                "--experts",
                "5",
                "--mmap-experts",
                "on"
            ])
        );
        let mut full = base;
        full.extend(["--experts", "6"].map(String::from));
        assert_ne!(resource_configuration(&full).unwrap()["args"], fast["args"]);
    }

    #[test]
    fn custom_modes_and_ambiguous_capacity_do_not_become_default_recipes() {
        let mut args = [
            "strata",
            "--native",
            "/private/Qwen3.8-IQ3_S.gguf",
            "--max-context",
            "32768",
            "--mmap-experts",
        ]
        .map(str::to_owned)
        .to_vec();
        assert!(resource_configuration(&args).unwrap()["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg == "--mmap-experts"));
        args.extend(["--max-context".into(), "131072".into()]);
        assert!(resource_configuration(&args).is_none());
    }
}
