//! Validated, task-scoped options for the official installer. No shell interpolation.
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, HashSet}, process::Command};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupOptions {
    pub source: Option<String>,
    pub hf_endpoint: Option<String>,
    pub backend: Option<String>,
    pub gpus: Option<String>,
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

impl SetupOptions {
    pub fn validated(&self) -> Result<Self, String> {
        let source = self.source.as_deref().unwrap_or("official");
        let backend = self.backend.as_deref().unwrap_or("auto");
        if !["official", "mirror", "modelscope"].contains(&source)
            || !["auto", "cuda", "hip", "sycl"].contains(&backend)
        {
            return Err("未知下载源或计算后端".into());
        }
        let gpus = normalize_gpus(self.gpus.as_deref().unwrap_or(""))?;
        if cfg!(windows) && backend == "hip" && (gpus == "all" || gpus.contains(',')) {
            return Err("官方 Windows AMD 安装器目前只支持单卡，请指定一个 GPU 编号".into());
        }
        Ok(Self {
            source: Some(source.into()),
            backend: Some(backend.into()),
            gpus: Some(gpus),
            hf_endpoint: if source == "mirror" {
                Some(validate_hf_endpoint(self.hf_endpoint.as_deref().unwrap_or(""))?)
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
        if !gpus.is_empty() {
            args.extend([
                if gpus == "all" || gpus.contains(',') { "--gpus" } else { "--gpu" }.into(),
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
        env.insert("STRATA_SOURCE".into(), Some(if options.source.as_deref() == Some("modelscope") { "modelscope" } else { "huggingface" }.into()));
        Ok(env)
    }

    pub fn apply_environment(&self, command: &mut Command) -> Result<(), String> {
        for (key, value) in self.environment()? {
            if let Some(value) = value { command.env(key, value); }
            else { command.env_remove(key); }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_flags_preserve_gpu_order_and_reject_duplicates_before_launch() {
        let options = SetupOptions { source: Some("modelscope".into()), backend: Some("cuda".into()), gpus: Some("2, 0".into()), ..Default::default() };
        let mut args = vec!["setup.py".into(), "--no-start".into()];
        options.append_args(&mut args).unwrap();
        assert_eq!(args, ["setup.py", "--no-start", "--source", "modelscope", "--backend", "cuda", "--gpus", "2,0"]);
        for invalid in ["0,0", "-1", "256", "0 --build", "0,", "0\n"] {
            assert!(normalize_gpus(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn explicit_source_only_changes_the_child_environment() {
        let mut command = Command::new("python");
        let options = SetupOptions { source: Some("mirror".into()), hf_endpoint: Some("https://hf-mirror.com/".into()), ..Default::default() };
        options.apply_environment(&mut command).unwrap();
        let entries: std::collections::HashMap<_, _> = command.get_envs().map(|(k,v)| (k.to_string_lossy().into_owned(), v.map(|value| value.to_string_lossy().into_owned()))).collect();
        assert_eq!(entries["HF_ENDPOINT"], Some("https://hf-mirror.com".into()));
        assert_eq!(entries["STRATA_SOURCE"], Some("huggingface".into()));
        assert_eq!(entries["MODELSCOPE_ENDPOINT"], None);
        let mut official = Command::new("python");
        SetupOptions::default().apply_environment(&mut official).unwrap();
        assert!(official.get_envs().any(|(key, value)| key == "HF_ENDPOINT" && value.is_none()));
    }

    #[test]
    fn mirror_address_does_not_accept_credentials_queries_or_command_text() {
        for invalid in ["http://mirror.example", "https://u:p@mirror.example", "https://mirror.example?token=x", "https://mirror.example/#secret", "https://mirror.example\\x", "https://mirror.example\n"] {
            assert!(validate_hf_endpoint(invalid).is_err(), "{invalid}");
        }
        assert_eq!(validate_hf_endpoint("https://mirror.example/base/").unwrap(), "https://mirror.example/base");
    }
}
