//! User-prepared engine bytes retain the official release identity and digest.
use super::{cancelled, RuntimeReleaseAsset};
use crate::{installation, processes, RuntimeState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeZipDownloadOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_archive_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    /// Install this official release instead of the latest one (up or down). Sent only
    /// with `update_runtime_zip_version_v1`, so an older background service refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_version: Option<String>,
}

impl RuntimeZipDownloadOptions {
    pub fn is_custom(&self) -> bool {
        self.local_archive_path.is_some() || self.download_url.is_some()
    }

    pub fn validate(mut self, asset_name: Option<&str>) -> Result<Self, String> {
        self.local_archive_path = self
            .local_archive_path
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_owned());
        self.download_url = self
            .download_url
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_owned());
        self.target_version = self
            .target_version
            .map(|value| value.trim().trim_start_matches('v').to_owned())
            .filter(|value| !value.is_empty());
        if let Some(version) = &self.target_version {
            if !crate::runtime_upgrade::engine_package::valid_version(version) {
                return Err("所选 Strata 版本号无效 / Invalid Strata version".into());
            }
        }
        if self.local_archive_path.is_some() && self.download_url.is_some() {
            return Err("本地引擎包 和镜像下载地址只能选择一种".into());
        }
        if self.is_custom() && asset_name.is_none_or(str::is_empty) {
            return Err("使用本地引擎包 或镜像前，请选择对应的官方更新包".into());
        }
        if let Some(path) = &self.local_archive_path {
            let path = Path::new(path);
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !path.is_absolute()
                || !installation::local_archive::WINDOWS_ENGINE_EXTENSIONS
                    .iter()
                    .any(|extension| name.ends_with(extension))
            {
                return Err("本地更新包必须是绝对路径的 ZIP 或 tar.gz 文件 / The local package must be an absolute path to a ZIP or tar.gz file".into());
            }
        }
        if let Some(value) = &self.download_url {
            let url = mirror_url(value)?;
            self.download_url = Some(url.to_string());
        }
        Ok(self)
    }

    /// An accepted request remains idempotent even if its original file moves.
    /// Only admitting a new task requires the user-selected file to still exist.
    pub fn validate_local_file(&self) -> Result<(), String> {
        if let Some(path) = &self.local_archive_path {
            let metadata =
                std::fs::metadata(path).map_err(|error| format!("无法读取本地引擎包：{error}"))?;
            if !metadata.is_file() {
                return Err("本地更新包不是普通文件".into());
            }
        }
        Ok(())
    }
}

fn mirror_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "镜像地址必须是完整的 HTTPS 引擎包 下载地址")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("镜像地址必须使用 HTTPS，且不能包含凭据或片段".into());
    }
    Ok(url)
}

pub(super) async fn engine_archive(
    state: &RuntimeState,
    id: &str,
    asset: &RuntimeReleaseAsset,
    options: &RuntimeZipDownloadOptions,
    work: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = &options.local_archive_path {
        return import_archive(
            state,
            id,
            Path::new(path),
            asset,
            &work.join(
                if super::engine_package::parse_package_name(&asset.name).is_some() {
                    "local-engine.tar.gz"
                } else {
                    "local-engine.zip"
                },
            ),
        );
    }
    let archive = if let Some(url) = &options.download_url {
        mirror_url(url)?;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("mirror redirect limit exceeded");
                }
                if mirror_url(attempt.url().as_str()).is_ok() {
                    attempt.follow()
                } else {
                    attempt.error("mirror redirect must remain HTTPS without credentials")
                }
            }))
            .build()
            .map_err(|error| error.to_string())?;
        match installation::download_using_client(
            state,
            id,
            url,
            &asset.sha256,
            asset.size,
            &client,
        )
        .await
        {
            Ok(archive) => archive,
            // The mirror is the default; GitHub is the fallback. Both are held to the
            // same official size and SHA-256, so falling back never weakens a check.
            Err(error) => {
                cancelled(state, id)?;
                processes::log(
                    &state.logs,
                    id,
                    "warn",
                    format!("镜像下载未完成（{error}），改用 GitHub 官方地址重试"),
                );
                installation::download_release(state, id, &asset.url, &asset.sha256, asset.size)
                    .await
                    .map_err(|official| {
                        format!("镜像和 GitHub 都没能下载引擎包。镜像：{error}；GitHub：{official}")
                    })?
            }
        }
    } else {
        installation::download_release(state, id, &asset.url, &asset.sha256, asset.size).await?
    };
    if archive.metadata().map_err(|error| error.to_string())?.len() != asset.size {
        return Err("引擎包 精确长度与官方 Release 清单不符".into());
    }
    Ok(archive)
}

fn import_archive(
    state: &RuntimeState,
    id: &str,
    path: &Path,
    asset: &RuntimeReleaseAsset,
    destination: &Path,
) -> Result<PathBuf, String> {
    cancelled(state, id)?;
    let mut source = File::open(path).map_err(|error| format!("无法读取本地引擎包：{error}"))?;
    let metadata = source.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() != asset.size {
        return Err("本地引擎包 的长度与所选官方更新包不符，请检查版本和 GPU 类型".into());
    }
    processes::log(
        &state.logs,
        id,
        "info",
        format!("正在读取本地更新包 {}；按官方 SHA256 校验", path.display()),
    );
    let mut output =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("本地更新暂存目录不存在")?)
            .map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    let mut received = 0u64;
    let mut at = Instant::now();
    loop {
        cancelled(state, id)?;
        let count = source
            .read(&mut buffer)
            .map_err(|error| format!("本地引擎包 读取失败：{error}"))?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > asset.size {
            return Err("读取期间本地引擎包 长度发生变化，已拒绝安装".into());
        }
        hash.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        if at.elapsed().as_secs() >= 1 {
            processes::log(
                &state.logs,
                id,
                "info",
                format!(
                    "已读取本地引擎包 {}",
                    crate::byte_size::progress_amount(received, Some(asset.size), None)
                ),
            );
            at = Instant::now();
        }
    }
    if received != asset.size || format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err("本地引擎包 的 SHA256 与所选官方更新包不符，已拒绝解包或安装".into());
    }
    cancelled(state, id)?;
    output
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    output
        .persist_noclobber(destination)
        .map_err(|error| error.to_string())?;
    processes::log(
        &state.logs,
        id,
        "info",
        format!(
            "本地引擎包 官方 SHA256 校验通过，共 {}；原文件保持不变",
            crate::byte_size::human_bytes(received)
        ),
    );
    Ok(destination.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        processes::TaskRecord,
        types::{now, TaskStatus},
    };
    fn task(state: &RuntimeState) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            TaskRecord {
                status: TaskStatus {
                    id: id.clone(),
                    kind: "update".into(),
                    state: "running".into(),
                    message: String::new(),
                    started_at: now(),
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        id
    }
    fn asset(bytes: &[u8]) -> RuntimeReleaseAsset {
        RuntimeReleaseAsset {
            name: "strata-windows-x64.zip".into(),
            url: "https://github.com/unused.zip".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            variant: "cuda13".into(),
            ..Default::default()
        }
    }
    #[test]
    fn a_chosen_version_is_normalized() {
        let chosen = |version: &str| RuntimeZipDownloadOptions {
            target_version: Some(version.into()),
            ..Default::default()
        };
        assert_eq!(
            chosen(" v0.1.44 ")
                .validate(None)
                .unwrap()
                .target_version
                .as_deref(),
            Some("0.1.44")
        );
        assert_eq!(
            chosen("0.2.0-beta")
                .validate(None)
                .unwrap()
                .target_version
                .as_deref(),
            Some("0.2.0-beta")
        );
        assert_eq!(chosen("  ").validate(None).unwrap().target_version, None);
        assert!(chosen("latest").validate(None).is_err());
        assert!(chosen("../0.1").validate(None).is_err());
        // Any source still has to match the chosen release's verified digest and size.
        let mirror = RuntimeZipDownloadOptions {
            download_url: Some("https://mirror.example/strata-windows-x64.zip".into()),
            target_version: Some("0.1.44".into()),
            ..Default::default()
        };
        assert!(mirror.validate(Some("strata-windows-x64.zip")).is_ok());
    }

    #[test]
    fn options_require_an_explicit_official_asset_and_safe_source() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("engine.zip");
        std::fs::write(&local, b"zip").unwrap();
        let local = local.to_string_lossy().into_owned();
        let options = RuntimeZipDownloadOptions {
            local_archive_path: Some(local.clone()),
            download_url: None,
            target_version: None,
        };
        assert!(options.clone().validate(None).is_err());
        assert!(options.validate(Some("strata-windows-x64.zip")).is_ok());
        for url in [
            "http://mirror.test/a.zip",
            "https://user:secret@mirror.test/a.zip",
            "https://mirror.test/a.zip#fragment",
            "file:///engine.zip",
        ] {
            assert!(RuntimeZipDownloadOptions {
                local_archive_path: None,
                download_url: Some(url.into()),
                target_version: None,
            }
            .validate(Some("strata-windows-x64.zip"))
            .is_err());
        }
        assert!(RuntimeZipDownloadOptions {
            local_archive_path: Some(local),
            download_url: Some("https://mirror.test/a.zip".into()),
            target_version: None,
        }
        .validate(Some("strata-windows-x64.zip"))
        .is_err());
        assert!(RuntimeZipDownloadOptions {
            local_archive_path: None,
            download_url: Some("https://mirror.test/download?token=123".into()),
            target_version: None,
        }
        .validate(Some("strata-windows-x64.zip"))
        .is_ok());
        assert_eq!(
            serde_json::from_str::<RuntimeZipDownloadOptions>("{}").unwrap(),
            RuntimeZipDownloadOptions::default()
        );
    }
    #[tokio::test]
    async fn local_archive_is_copied_verified_and_never_downloaded_or_modified() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let bytes = b"official fixture";
        let source = temp.path().join("engine.zip");
        std::fs::write(&source, bytes).unwrap();
        let options = RuntimeZipDownloadOptions {
            local_archive_path: Some(source.to_string_lossy().into()),
            download_url: None,
            target_version: None,
        };
        let staged = engine_archive(&state, &id, &asset(bytes), &options, temp.path())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), bytes);
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert!(!state.data_dir().join("downloads").exists());
    }
    #[test]
    fn incorrect_or_cancelled_local_archive_is_not_published() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let source = temp.path().join("engine.zip");
        let output = temp.path().join("staged.zip");
        std::fs::write(&source, b"different bytes!").unwrap();
        let mut official = asset(b"official fixture");
        official.size = 16;
        assert!(import_archive(&state, &id, &source, &official, &output)
            .unwrap_err()
            .contains("SHA256"));
        assert!(!output.exists());
        official.size = 123;
        assert!(import_archive(&state, &id, &source, &official, &output)
            .unwrap_err()
            .contains("长度"));
        assert!(!output.exists());
        state.tasks.lock().unwrap().get_mut(&id).unwrap().cancelled = true;
        assert!(import_archive(&state, &id, &source, &official, &output)
            .unwrap_err()
            .contains("取消"));
        assert!(!output.exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"different bytes!");
    }
}
