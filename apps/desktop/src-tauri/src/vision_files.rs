use serde_json::Value;
use std::path::{Path, PathBuf};
use strata_runtime_core::types::ServiceProfile;

use crate::mac_vision::{self, MacVisionSupport};

fn resolve(base: &Path, value: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    if !resolved.is_absolute() {
        return Err(format!(
            "{label} 必须是绝对路径或工作目录相对路径 / must be an absolute path or relative to the working directory"
        ));
    }
    Ok(resolved)
}

fn working_directory(profile: &ServiceProfile, config: &Value) -> Result<PathBuf, String> {
    let installation = Path::new(&profile.install_dir);
    let cwd = match config.get("cwd") {
        None | Some(Value::Null) => installation.to_path_buf(),
        Some(Value::String(value)) if value.is_empty() => installation.to_path_buf(),
        Some(Value::String(value)) => {
            resolve(installation, value, "工作目录 cwd / Working directory cwd")?
        }
        Some(_) => {
            return Err("工作目录 cwd 必须是字符串 / working directory cwd must be a string".into())
        }
    };
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(format!(
            "工作目录 cwd 不存在或不是绝对目录 / working directory cwd is missing or is not an absolute directory: {}",
            cwd.display()
        ));
    }
    Ok(cwd)
}

/// Whether this Mac can start the configured picture reader; `None` off macOS or when it cannot be read.
pub fn mac_support(profile: &ServiceProfile, config: &Value) -> Option<MacVisionSupport> {
    let exe = config.pointer("/vision/exe")?.as_str()?.trim();
    if exe.is_empty() {
        return None;
    }
    let cwd = working_directory(profile, config).ok()?;
    mac_vision::support(&resolve(&cwd, exe, "vision.exe").ok()?)
}

/// The server starts in install_dir and resolves vision paths against config.cwd.
/// Only filesystem metadata is read (plus, on macOS, the vision engine's Mach-O header); nothing is started.
pub fn check(profile: &ServiceProfile, config: &Value) -> Result<(), String> {
    let vision = config.get("vision").and_then(Value::as_object).ok_or(
        "视觉配置 vision 缺失或不是对象 / vision configuration is missing or is not an object",
    )?;
    let cwd = working_directory(profile, config)?;
    for (key, label) in [
        (
            "exe",
            "视觉引擎路径 vision.exe / Vision engine path vision.exe",
        ),
        (
            "model",
            "主模型路径 vision.model / Language model path vision.model",
        ),
        (
            "mmproj",
            "视觉投影路径 vision.mmproj / Vision projector path vision.mmproj",
        ),
    ] {
        let value = vision
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("{label} 必须填写文件路径 / a file path is required"))?;
        let path = resolve(&cwd, value, label)?;
        if !path.is_file() {
            return Err(format!(
                "{label} 文件不存在或不是文件 / file is missing or is not a file: {}",
                path.display()
            ));
        }
        if key == "exe" {
            if let Some(support) = mac_vision::support(&path).filter(|support| !support.supported) {
                return Err(format!(
                    "图像输入需要 macOS {} 或更高，本机为 {} / image input needs macOS {} or later; this Mac runs {}",
                    support.required, support.system, support.required, support.system
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check;
    use serde_json::{json, Value};
    use std::{fs, path::Path};
    use strata_runtime_core::types::ServiceProfile;

    fn profile(root: &Path) -> ServiceProfile {
        ServiceProfile {
            id: "vision-test".into(),
            name: "Vision test".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: String::new(),
            // The imported config's directory is intentionally not the cwd.
            config_path: root.join("imports/config.json").to_string_lossy().into(),
            managed: true,
        }
    }

    fn assets(root: &Path) -> Value {
        fs::create_dir_all(root.join("assets")).unwrap();
        for name in ["strata-vision.exe", "model.gguf", "mmproj.gguf"] {
            fs::write(root.join("assets").join(name), "fixture").unwrap();
        }
        json!({"vision": {
            "exe": "assets/strata-vision.exe", "model": "assets/model.gguf", "mmproj": "assets/mmproj.gguf"
        }})
    }

    #[test]
    fn default_and_empty_cwd_resolve_from_installation() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = assets(temp.path());
        let selected = profile(temp.path());
        assert!(check(&selected, &config).is_ok());
        for cwd in [json!(null), json!("")] {
            config["cwd"] = cwd;
            assert!(check(&selected, &config).is_ok());
        }
    }

    #[test]
    fn relative_cwd_resolves_against_installation_not_imported_config() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = assets(&temp.path().join("work"));
        config["cwd"] = json!("work");
        assert!(check(&profile(temp.path()), &config).is_ok());
        config["cwd"] = json!("imports");
        assert!(check(&profile(temp.path()), &config)
            .unwrap_err()
            .contains("cwd"));
    }

    #[test]
    fn absolute_cwd_and_asset_paths_are_preserved() {
        let installation = tempfile::tempdir().unwrap();
        let working = tempfile::tempdir().unwrap();
        let mut config = assets(working.path());
        config["cwd"] = json!(working.path());
        assert!(check(&profile(installation.path()), &config).is_ok());
        config.as_object_mut().unwrap().remove("cwd");
        for key in ["exe", "model", "mmproj"] {
            let relative = config["vision"][key].as_str().unwrap();
            config["vision"][key] = json!(working.path().join(relative));
        }
        assert!(check(&profile(installation.path()), &config).is_ok());
    }

    #[test]
    fn every_asset_is_required_and_must_be_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let original = assets(temp.path());
        let selected = profile(temp.path());
        for key in ["exe", "model", "mmproj"] {
            let mut missing = original.clone();
            missing["vision"].as_object_mut().unwrap().remove(key);
            assert!(check(&selected, &missing)
                .unwrap_err()
                .contains(&format!("vision.{key}")));
            for value in [
                json!(""),
                json!("  "),
                json!(42),
                json!("missing.gguf"),
                json!("assets"),
            ] {
                let mut invalid = original.clone();
                invalid["vision"][key] = value;
                let error = check(&selected, &invalid).unwrap_err();
                assert!(error.contains(&format!("vision.{key}")), "{error}");
                assert!(error.contains(" / "), "{error}");
            }
        }
        assert!(check(&selected, &json!({})).is_err());
        assert!(check(&selected, &json!({"vision": null})).is_err());
    }
}
