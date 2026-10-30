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
/// DeepSeek-V4.1 (arch deepseek41) names its model by the --pack folder only.
fn is_deepseek41(args: &[String]) -> bool {
    option(args, &["--pack"]).is_some() && option(args, &["--native", "--model", "-m"]).is_none()
}
/// Whether the engine reads pictures. DeepSeek-V4.1 takes `--vision on|off` (upstream v0.2.8 writes
/// it into every config), so only an explicit on counts there; Qwen's `--vision` is a bare switch.
fn vision_enabled(args: &[String]) -> bool {
    let deepseek = is_deepseek41(args);
    let mut enabled = false;
    for (index, arg) in args.iter().enumerate() {
        let value = if arg == "--vision" {
            args.get(index + 1)
                .filter(|next| !next.starts_with('-'))
                .map(String::as_str)
        } else if let Some(value) = arg.strip_prefix("--vision=") {
            Some(value)
        } else {
            continue;
        };
        enabled = match value.map(str::to_ascii_lowercase).as_deref() {
            Some("off" | "no" | "false" | "0") => false,
            Some("on" | "yes" | "true" | "1" | "gpu" | "cpu") => true,
            // DeepSeek's --vision needs a value: a missing or unknown one is not a picture-reading run.
            Some(_) | None => !deepseek && value.is_none(),
        };
    }
    enabled
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
        &["--reserve-mib"],
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
        // DeepSeek-V4.1 takes the room left for other apps as --reserve-mib (upstream v0.2.8).
        "--reserve-mib",
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
    if vision_enabled(args) {
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
/// Draft flags upstream v0.2.6 strips when drafting is "off" (strata_control/drafting.py).
const DRAFT_VALUE_FLAGS: &[&str] = &["--mtp", "--spec-min-p", "--draft", "--draft-model"];
const DRAFT_SWITCH_FLAGS: &[&str] = &["--batch-mtp"];

fn flag_name(arg: &str) -> &str {
    arg.split_once('=').map(|(name, _)| name).unwrap_or(arg)
}

/// Engine args without the drafting flags: two runs that differ only in MTP on/off share this hash.
fn base_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let name = flag_name(arg);
        if DRAFT_VALUE_FLAGS.contains(&name) {
            if !arg.contains('=') {
                iter.next();
            }
            continue;
        }
        if DRAFT_SWITCH_FLAGS.contains(&name) {
            continue;
        }
        out.push(arg.clone());
    }
    out
}

/// What the engine command line actually drafts with.
fn effective_drafting(args: &[String]) -> &'static str {
    if option(args, &["--draft"]).is_some_and(|value| value.eq_ignore_ascii_case("dflash2")) {
        "dflash2"
    } else if args.iter().any(|arg| flag_name(arg) == "--mtp") {
        "mtp"
    } else {
        "off"
    }
}

fn requested_drafting(config: &Value) -> Option<&'static str> {
    let value = config
        .get("drafting")?
        .as_str()?
        .trim()
        .to_ascii_lowercase();
    Some(match value.as_str() {
        "mtp" => "mtp",
        "dflash2" => "dflash2",
        "off" => "off",
        _ => "auto",
    })
}

/// `{"requested": config drafting, "mtpSwitch": the boolean config "mtp" (a path string is not a switch), "effective": from the engine args}`.
/// DeepSeek-V4.1 (arch deepseek41) runs strata-dsv41, which has no MTP/DFlash drafting: no drafting identity.
fn drafting_identity(config: &Value, effective_args: Option<&[String]>) -> Value {
    if config["arch"] == crate::disk::dsv41::FAMILY {
        return Value::Null;
    }
    json!({
        "requested": requested_drafting(config),
        "mtpSwitch": config.get("mtp").and_then(Value::as_bool),
        "effective": effective_args.map(effective_drafting),
    })
}

/// Saved GPU roles as tokens ordered by card index; None unless gpu_roles is a valid {index: main|helper|off} map.
fn gpu_roles(config: &Value) -> Option<Vec<&'static str>> {
    let roles = config.get("gpu_roles")?.as_object()?;
    let mut out = Vec::new();
    for (key, value) in roles {
        let index: u32 = key.trim().parse().ok()?;
        let role = match value.as_str()?.trim().to_ascii_lowercase().as_str() {
            "main" => "main",
            "helper" => "helper",
            "off" => "off",
            _ => return None,
        };
        out.push((index, role));
    }
    out.sort_by_key(|(index, _)| *index);
    if out.is_empty() || out.iter().filter(|(_, role)| *role == "main").count() > 1 {
        return None;
    }
    Some(out.into_iter().map(|(_, role)| role).collect())
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
    let effective_base_hash = startup
        .as_ref()
        .map(|startup| digest(&json!(base_args(&startup.args))));
    let drafting = drafting_identity(
        &config,
        startup.as_ref().map(|startup| startup.args.as_slice()),
    );
    let gpu_roles = gpu_roles(&config);
    let hardware_signature = crate::resource_assessment::hardware_signature(state)?;
    let engine_process = startup
        .as_ref()
        .map(|s| json!({"pid":s.pid,"startedAt":s.started_at}));
    Ok(
        json!({"schemaVersion":1,"capturedAt":crate::now(),"process":{"pid":process.pid,"startedAt":process.started_at,"running":process.running},"runtime":{"strength":if runtime.is_some(){"metadata"}else{"unknown"},"fingerprint":runtime.as_ref().map(digest)},"model":{"strength":if files.is_empty(){"unknown"}else{"metadata"},"fingerprint":if files.is_empty(){None}else{Some(digest(&json!(files)))},"files":files},"savedConfigurationHash":digest(&config),"effectiveStartupHash":effective_hash,"effectiveBaseHash":effective_base_hash,"drafting":drafting,"gpuRoles":gpu_roles,"effectiveVerified":startup.is_some(),"residentEvidence":resident,"resourceConfiguration":resource_configuration,"hardwareSignature":hardware_signature,"engineProcess":engine_process}),
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
    fn deepseek41_vision_reads_on_off_and_reserve_mib_groups() {
        let base = [
            "--pack",
            "/models/packs/deepseek-v4.1-flash-ist-das-2.00bpw",
            "--max-context",
            "8192",
            "--reserve-mib",
            "600",
        ]
        .map(String::from)
        .to_vec();
        let with = |extra: &[&str]| {
            let mut args = base.clone();
            args.extend(extra.iter().map(|arg| arg.to_string()));
            resource_configuration(&args).unwrap()
        };
        let plain = with(&[]);
        assert!(plain.get("vision").is_none());
        assert_eq!(
            plain["args"],
            json!([
                "--max-context",
                "8192",
                "--pack",
                "deepseek-v4.1-flash-ist-das-2.00bpw",
                "--reserve-mib",
                "600"
            ])
        );
        assert!(with(&["--vision", "off"]).get("vision").is_none());
        assert!(with(&["--vision=off"]).get("vision").is_none());
        assert!(with(&["--vision"]).get("vision").is_none());
        assert!(with(&["--vision", "--eos", "1"]).get("vision").is_none());
        assert_eq!(with(&["--vision", "on"])["vision"], json!(true));
        assert_eq!(with(&["--vision=on"])["vision"], json!(true));
        let mut other = base.clone();
        other[5] = "1200".into();
        assert_ne!(
            resource_configuration(&other).unwrap()["args"],
            plain["args"]
        );
    }

    #[test]
    fn qwen_vision_stays_a_bare_switch() {
        let base = [
            "--native",
            "/m/Qwen3.8-IQ3_S.gguf",
            "--max-context",
            "32768",
        ]
        .map(String::from)
        .to_vec();
        assert!(resource_configuration(&base)
            .unwrap()
            .get("vision")
            .is_none());
        let mut bare = base.clone();
        bare.push("--vision".into());
        assert_eq!(
            resource_configuration(&bare).unwrap()["vision"],
            json!(true)
        );
        let mut middle = vec!["--vision".to_string()];
        middle.extend(base);
        assert_eq!(
            resource_configuration(&middle).unwrap()["vision"],
            json!(true)
        );
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

#[cfg(test)]
mod drafting_tests {
    use super::*;
    fn owned(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }
    #[test]
    fn mtp_on_and_off_share_the_base_hash_but_not_the_startup_hash() {
        let on = owned(&[
            "strata",
            "--native",
            "/m/q.gguf",
            "--mtp",
            "/m/mtp",
            "--spec-min-p",
            "0.2",
            "--batch-mtp",
            "--max-context",
            "32768",
        ]);
        let off = owned(&["strata", "--native", "/m/q.gguf", "--max-context", "32768"]);
        assert_ne!(digest(&json!(on)), digest(&json!(off)));
        assert_eq!(
            digest(&json!(base_args(&on))),
            digest(&json!(base_args(&off)))
        );
        assert_eq!(
            base_args(&owned(&[
                "s",
                "--mtp=/m/mtp",
                "--draft",
                "dflash2",
                "--kv",
                "int8"
            ])),
            owned(&["s", "--kv", "int8"])
        );
        assert_eq!(effective_drafting(&on), "mtp");
        assert_eq!(effective_drafting(&off), "off");
        assert_eq!(
            effective_drafting(&owned(&["s", "--mtp", "/m", "--draft", "dflash2"])),
            "dflash2"
        );
    }
    #[test]
    fn drafting_identity_reads_the_request_and_only_a_boolean_mtp_switch() {
        let args = owned(&["s", "--mtp", "/m"]);
        assert_eq!(
            drafting_identity(&json!({"drafting":"OFF","mtp":false}), Some(&args)),
            json!({"requested":"off","mtpSwitch":false,"effective":"mtp"})
        );
        assert_eq!(
            drafting_identity(&json!({"drafting":"weird","mtp":"/models/mtp"}), None),
            json!({"requested":"auto","mtpSwitch":null,"effective":null})
        );
        assert_eq!(
            drafting_identity(&json!({"arch":"deepseek41","args":[]}), Some(&[])),
            Value::Null
        );
        assert_eq!(
            drafting_identity(&json!({}), Some(&[])),
            json!({"requested":null,"mtpSwitch":null,"effective":"off"})
        );
    }
    #[test]
    fn gpu_roles_are_ordered_tokens_or_nothing() {
        assert_eq!(
            gpu_roles(&json!({"gpu_roles":{"2":"off","0":"helper","1":"MAIN"}})),
            Some(vec!["helper", "main", "off"])
        );
        assert_eq!(
            gpu_roles(&json!({"gpu_roles":{"0":"main","1":"main"}})),
            None
        );
        assert_eq!(gpu_roles(&json!({"gpu_roles":{"x":"main"}})), None);
        assert_eq!(gpu_roles(&json!({"gpu":[0]})), None);
    }
}
