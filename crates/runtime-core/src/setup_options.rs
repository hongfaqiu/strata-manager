//! Validated, task-scoped options for the official installer. No shell interpolation.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    process::Command,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupOptions {
    pub source: Option<String>,
    pub hf_endpoint: Option<String>,
    pub backend: Option<String>,
    pub gpus: Option<String>,
    /// Strata 0.2.2 setup.py --gpu-roles: `0=helper,1=main` (cards not named are Off).
    /// When given it decides the cards; `gpus` may only repeat the cards it turns on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_roles: Option<String>,
}

fn has_controls(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

pub fn validate_hf_endpoint(value: &str) -> Result<String, String> {
    if has_controls(value) || value.contains('\\') {
        return Err("HF 镜像地址包含无效字符".into());
    }
    let endpoint = url::Url::parse(value.trim()).map_err(|_| "请填写完整 HTTPS 镜像地址")?;
    if endpoint.scheme() != "https"
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("HF 镜像地址必须为 HTTPS，且不能包含凭据、查询参数或片段".into());
    }
    Ok(endpoint.as_str().trim_end_matches('/').to_owned())
}

pub fn normalize_gpus(value: &str) -> Result<String, String> {
    if has_controls(value) {
        return Err("GPU 编号包含无效字符".into());
    }
    let value = value.trim();
    if value.is_empty() || value == "all" {
        return Ok(value.to_owned());
    }
    let mut seen = HashSet::new();
    let mut indices = Vec::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
            return Err("GPU 请输入编号、逗号分隔编号或 all".into());
        }
        let index: u8 = part.parse().map_err(|_| "GPU 编号必须为 0–255")?;
        if !seen.insert(index) || indices.len() >= 8 {
            return Err("GPU 编号不能重复，且最多 8 个".into());
        }
        indices.push(index.to_string());
    }
    Ok(indices.join(","))
}

/// setup.py parse_roles (v0.2.2): `number=role` pairs, one Main at most, at least one card on.
/// Returns the canonical text (by card number) and the cards that are on.
pub fn normalize_gpu_roles(value: &str) -> Result<(String, Vec<u8>), String> {
    if has_controls(value) {
        return Err("显卡角色包含无效字符".into());
    }
    let mut roles = BTreeMap::new();
    for part in value.replace(';', ",").split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (card, role) = part
            .split_once('=')
            .or_else(|| part.split_once(':'))
            .ok_or("显卡角色请写成 编号=main|helper|off，例如 1=main,0=helper")?;
        let card = card.trim();
        let role = role.trim().to_ascii_lowercase();
        if card.is_empty() || !card.bytes().all(|c| c.is_ascii_digit()) {
            return Err("显卡角色的编号必须为数字".into());
        }
        let card: u8 = card.parse().map_err(|_| "GPU 编号必须为 0–255")?;
        if !["main", "helper", "off"].contains(&role.as_str()) {
            return Err("显卡角色只能是 main、helper 或 off".into());
        }
        if roles.insert(card, role).is_some() || roles.len() > 8 {
            return Err("显卡角色的编号不能重复，且最多 8 张卡".into());
        }
    }
    let on: Vec<u8> = roles
        .iter()
        .filter(|(_, role)| role.as_str() != "off")
        .map(|(card, _)| *card)
        .collect();
    if roles
        .values()
        .filter(|role| role.as_str() == "main")
        .count()
        > 1
    {
        return Err("只能有一张主卡（main）".into());
    }
    if on.is_empty() {
        return Err("安装时至少需要一张主卡或辅助卡".into());
    }
    let text = roles
        .iter()
        .map(|(card, role)| format!("{card}={role}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok((text, on))
}

/// Strata before 0.2.2 has no --gpu-roles and would stop at an unknown option.
pub fn setup_supports_gpu_roles(root: &std::path::Path) -> bool {
    std::fs::read_to_string(root.join("setup.py"))
        .is_ok_and(|text| text.contains("\"--gpu-roles\""))
}

impl SetupOptions {
    pub fn validated(&self) -> Result<Self, String> {
        let source = self.source.as_deref().unwrap_or("official");
        let backend = self.backend.as_deref().unwrap_or("auto");
        if !["official", "mirror", "modelscope"].contains(&source)
            || !["auto", "cuda", "hip", "sycl"].contains(&backend)
        {
            return Err("未知下载源或计算后端".into());
        }
        let mut gpus = normalize_gpus(self.gpus.as_deref().unwrap_or(""))?;
        let gpu_roles = match self.gpu_roles.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(text) => {
                let (roles, on) = normalize_gpu_roles(text)?;
                let mut asked: Vec<u8> = gpus
                    .split(',')
                    .filter(|part| !part.is_empty())
                    .filter_map(|part| part.parse().ok())
                    .collect();
                asked.sort_unstable();
                if gpus == "all" || (!asked.is_empty() && asked != on) {
                    return Err("显卡角色与所选 GPU 编号不一致".into());
                }
                gpus = on.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
                Some(roles)
            }
        };
        if cfg!(windows) && backend == "hip" && (gpus == "all" || gpus.contains(',')) {
            return Err("官方 Windows AMD 安装器目前只支持单卡，请指定一个 GPU 编号".into());
        }
        Ok(Self {
            gpu_roles,
            source: Some(source.into()),
            backend: Some(backend.into()),
            gpus: Some(gpus),
            hf_endpoint: if source == "mirror" {
                Some(validate_hf_endpoint(
                    self.hf_endpoint.as_deref().unwrap_or(""),
                )?)
            } else {
                None
            },
        })
    }

    pub fn append_args(&self, args: &mut Vec<String>) -> Result<(), String> {
        let options = self.validated()?;
        args.extend([
            "--source".into(),
            if options.source.as_deref() == Some("modelscope") {
                "modelscope".into()
            } else {
                "huggingface".into()
            },
        ]);
        let backend = options.backend.as_deref().unwrap_or("auto");
        if backend != "auto" {
            args.extend(["--backend".into(), backend.into()]);
        }
        let gpus = options.gpus.as_deref().unwrap_or("");
        if let Some(roles) = &options.gpu_roles {
            // setup.py: --gpu-roles and --gpu / --gpus are exclusive; the roles name the cards.
            args.extend(["--gpu-roles".into(), roles.clone()]);
        } else if !gpus.is_empty() {
            args.extend([
                if gpus == "all" || gpus.contains(',') {
                    "--gpus"
                } else {
                    "--gpu"
                }
                .into(),
                gpus.into(),
            ]);
        }
        Ok(())
    }

    /// Explicit choices override inherited source variables only for this process.
    /// Omitted options should retain legacy behavior; call only on opted-in tasks.
    pub fn environment(&self) -> Result<BTreeMap<String, Option<String>>, String> {
        let options = self.validated()?;
        let mut env = BTreeMap::from([
            ("HF_ENDPOINT".into(), None),
            ("STRATA_SOURCE".into(), None),
            ("MODELSCOPE_ENDPOINT".into(), None),
        ]);
        if let Some(endpoint) = options.hf_endpoint {
            env.insert("HF_ENDPOINT".into(), Some(endpoint));
        }
        env.insert(
            "STRATA_SOURCE".into(),
            Some(
                if options.source.as_deref() == Some("modelscope") {
                    "modelscope"
                } else {
                    "huggingface"
                }
                .into(),
            ),
        );
        Ok(env)
    }

    pub fn apply_environment(&self, command: &mut Command) -> Result<(), String> {
        for (key, value) in self.environment()? {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every setup.py flag (and the choices) Manager passes exists in the pinned upstream
    /// source. Reads the verified upstream checkout (`STRATA_TEST_ROOT`, CI checks out the
    /// pinned revision); without one it only runs on CI, where a missing fixture fails.
    #[test]
    fn the_pinned_upstream_setup_accepts_every_flag_manager_passes() {
        let root = std::env::var_os("STRATA_TEST_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.reference/strata")
            });
        let Ok(setup) = std::fs::read_to_string(root.join("setup.py")) else {
            assert!(
                std::env::var_os("CI").is_none(),
                "CI must provide the pinned upstream checkout"
            );
            return;
        };
        for flag in [
            "--yes",
            "--setup",
            "--no-start",
            "--no-browser",
            "--family",
            "--model",
            "--context",
            "--vision",
            "--port",
            "--data-dir",
            "--gguf-dir",
            "--source",
            "--backend",
            "--gpu",
            "--gpus",
        ] {
            assert!(
                setup.contains(&format!("add_argument(\"{flag}\"")),
                "{flag}"
            );
        }
        assert!(setup.contains(
            r#"ap.add_argument("--vision", choices=["yes", "no", "none", "gpu", "cpu"]"#
        ));
        assert!(setup.contains(r#"ap.add_argument("--backend", choices=["cuda", "hip", "sycl"]"#));
        let sources = setup
            .lines()
            .find(|line| line.starts_with("SOURCES = ("))
            .expect("SOURCES");
        for source in ["\"modelscope\"", "\"huggingface\""] {
            assert!(sources.contains(source), "{sources}");
        }
    }

    #[test]
    fn strata_022_gpu_roles_replace_gpu_flags_and_are_checked_before_launch() {
        let options = SetupOptions {
            gpus: Some("2,0".into()),
            gpu_roles: Some(" 2=MAIN; 0:helper,1=off ".into()),
            ..Default::default()
        };
        let mut args = vec![];
        options.append_args(&mut args).unwrap();
        assert_eq!(
            args,
            [
                "--source",
                "huggingface",
                "--gpu-roles",
                "0=helper,1=off,2=main"
            ]
        );
        let validated = options.validated().unwrap();
        assert_eq!(validated.gpus.as_deref(), Some("0,2"));
        for bad in [
            "0=main,1=main",
            "0=off",
            "1=boss",
            "x=main",
            "0=main,0=helper",
            "1",
        ] {
            let options = SetupOptions {
                gpu_roles: Some(bad.into()),
                ..Default::default()
            };
            assert!(options.validated().is_err(), "{bad}");
        }
        for gpus in ["all", "0", "0,1"] {
            let options = SetupOptions {
                gpus: Some(gpus.into()),
                gpu_roles: Some("0=helper,2=main".into()),
                ..Default::default()
            };
            assert!(options.validated().is_err(), "{gpus}");
        }
        // An old task record without the field still reads.
        let old: SetupOptions =
            serde_json::from_str(r#"{"source":"official","gpus":"1"}"#).unwrap();
        assert!(old.gpu_roles.is_none());
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("setup.py"), "ap.add_argument(\"--gpus\")").unwrap();
        assert!(!setup_supports_gpu_roles(temp.path()));
        std::fs::write(
            temp.path().join("setup.py"),
            "ap.add_argument(\"--gpu-roles\", metavar=\"LIST\")",
        )
        .unwrap();
        assert!(setup_supports_gpu_roles(temp.path()));
    }

    #[test]
    fn setup_flags_preserve_gpu_order_and_reject_duplicates_before_launch() {
        let options = SetupOptions {
            source: Some("modelscope".into()),
            backend: Some("cuda".into()),
            gpus: Some("2, 0".into()),
            ..Default::default()
        };
        let mut args = vec!["setup.py".into(), "--no-start".into()];
        options.append_args(&mut args).unwrap();
        assert_eq!(
            args,
            [
                "setup.py",
                "--no-start",
                "--source",
                "modelscope",
                "--backend",
                "cuda",
                "--gpus",
                "2,0"
            ]
        );
        for invalid in ["0,0", "-1", "256", "0 --build", "0,", "0\n"] {
            assert!(normalize_gpus(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn explicit_source_only_changes_the_child_environment() {
        let mut command = Command::new("python");
        let options = SetupOptions {
            source: Some("mirror".into()),
            hf_endpoint: Some("https://hf-mirror.com/".into()),
            ..Default::default()
        };
        options.apply_environment(&mut command).unwrap();
        let entries: std::collections::HashMap<_, _> = command
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(entries["HF_ENDPOINT"], Some("https://hf-mirror.com".into()));
        assert_eq!(entries["STRATA_SOURCE"], Some("huggingface".into()));
        assert_eq!(entries["MODELSCOPE_ENDPOINT"], None);
        let mut official = Command::new("python");
        SetupOptions::default()
            .apply_environment(&mut official)
            .unwrap();
        assert!(official
            .get_envs()
            .any(|(key, value)| key == "HF_ENDPOINT" && value.is_none()));
    }

    #[test]
    fn mirror_address_does_not_accept_credentials_queries_or_command_text() {
        for invalid in [
            "http://mirror.example",
            "https://u:p@mirror.example",
            "https://mirror.example?token=x",
            "https://mirror.example/#secret",
            "https://mirror.example\\x",
            "https://mirror.example\n",
        ] {
            assert!(validate_hf_endpoint(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            validate_hf_endpoint("https://mirror.example/base/").unwrap(),
            "https://mirror.example/base"
        );
    }
}
