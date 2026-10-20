//! One-click, app-private CPython for macOS and Linux.
//!
//! macOS ships Python 3.9 (`/usr/bin/python3` from the Command Line Tools), below
//! Strata's 3.10 floor. Upstream `setup.sh` solves this with a pinned
//! python-build-standalone build; this module installs the same build into the
//! application data directory. No administrator rights, no PATH changes, and the
//! system or Homebrew Python is never touched.
//!
//! Integrity: every archive must match its exact byte length and SHA-256 taken
//! from the official release (GitHub asset digest, the release's checksum list
//! and, for Apple Silicon, upstream Strata's own `setup.sh` pin), whichever
//! source the bytes came from. Extraction checks every entry before writing and
//! the interpreter must pass the same 3.10+/venv/ensurepip probe as any other.
//!
//! Windows keeps the python.org installer in [`super::ensure_python`].
use super::{
    cancelled, download_release, download_using_client, installer_data_root, owned_directory,
    progress, python_probe,
};
use crate::{
    processes::{self, TaskRecord},
    types::{now, TaskStatus},
    RuntimeState,
};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read as _,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

/// python-build-standalone release tag (same build as upstream `setup.sh`).
pub const PBS_RELEASE: &str = "20261009";
/// CPython version of every pinned archive.
pub const PYTHON_VERSION: &str = "3.12.15";
const TASK_KIND: &str = "install-python";
const STORE_KEY: &str = "managedPythonInstallation";
const MARKER: &str = ".strata-manager-python.json";
const MAX_ENTRIES: usize = 20_000;
const MAX_EXPANDED: u64 = 512 * 1024 * 1024;

/// One pinned `install_only` archive.
#[derive(Debug, PartialEq, Eq)]
pub struct Distribution {
    /// Rust target triple used in the asset name.
    pub target: &'static str,
    /// Exact archive length in bytes.
    pub size: u64,
    /// Official SHA-256 of the archive.
    pub sha256: &'static str,
}

const DISTRIBUTIONS: [(&str, &str, Distribution); 4] = [
    (
        "macos",
        "aarch64",
        Distribution {
            target: "aarch64-apple-darwin",
            size: 25_165_569,
            sha256: "83dcb04777c798bd95f3687acf9ae84b09860272ee6bdfb05be8bcf9447f75b8",
        },
    ),
    (
        "macos",
        "x86_64",
        Distribution {
            target: "x86_64-apple-darwin",
            size: 24_868_017,
            sha256: "4c84ef5abe4bc145646175fce9b881936d60126b9a3f9a24c6308e2d035ca5c6",
        },
    ),
    (
        "linux",
        "x86_64",
        Distribution {
            target: "x86_64-unknown-linux-gnu",
            size: 66_913_335,
            sha256: "5864001bf969db329fadc2b654c4878c6027d170c6bd77e28f88666260bcaf63",
        },
    ),
    (
        "linux",
        "aarch64",
        Distribution {
            target: "aarch64-unknown-linux-gnu",
            size: 52_321_581,
            sha256: "b342ccfb577fda349d0237c98b24848234ca767c10f034628a5ff9fc858d662f",
        },
    ),
];

/// The pinned archive for an OS/arch, or `None` where one-click install is not
/// offered (Windows uses python.org; musl cannot run the glibc build).
pub fn distribution(os: &str, arch: &str, musl: bool) -> Option<&'static Distribution> {
    if musl {
        return None;
    }
    DISTRIBUTIONS
        .iter()
        .find(|(o, a, _)| *o == os && *a == arch)
        .map(|(_, _, distribution)| distribution)
}

fn current() -> Option<&'static Distribution> {
    distribution(
        std::env::consts::OS,
        std::env::consts::ARCH,
        cfg!(target_env = "musl"),
    )
}

impl Distribution {
    pub fn asset_name(&self) -> String {
        format!(
            "cpython-{PYTHON_VERSION}+{PBS_RELEASE}-{}-install_only.tar.gz",
            self.target
        )
    }

    pub fn official_url(&self) -> String {
        format!(
            "https://github.com/astral-sh/python-build-standalone/releases/download/{PBS_RELEASE}/{}",
            self.asset_name().replace('+', "%2B")
        )
    }
}

fn directory_name() -> String {
    format!("python-{PYTHON_VERSION}-pbs{PBS_RELEASE}")
}

/// `bin/python3` inside an extracted `install_only` tree.
fn interpreter_in(directory: &Path) -> PathBuf {
    directory.join("python").join("bin").join("python3")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    version: String,
    release: String,
    target: String,
    sha256: String,
    installed_at: u64,
}

/// The app-installed interpreter when its marker matches the pinned archive.
/// Does not run Python; callers probe it like any other candidate.
pub fn installed_interpreter(data_dir: &Path) -> Option<PathBuf> {
    let distribution = current()?;
    let directory = installer_data_root(data_dir)
        .ok()?
        .join("toolchains")
        .join(directory_name());
    let metadata = fs::symlink_metadata(&directory).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let marker_path = directory.join(MARKER);
    let marker_meta = fs::symlink_metadata(&marker_path).ok()?;
    if !marker_meta.is_file() || marker_meta.len() > 4096 {
        return None;
    }
    let marker: Marker = serde_json::from_slice(&fs::read(marker_path).ok()?).ok()?;
    if marker.sha256 != distribution.sha256 || marker.version != PYTHON_VERSION {
        return None;
    }
    let interpreter = interpreter_in(&directory);
    interpreter.is_file().then_some(interpreter)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPythonStatus {
    /// One-click install is offered on this OS/arch.
    pub supported: bool,
    /// CPython version that would be (or is) installed.
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_bytes: Option<u64>,
    /// A verified app-private interpreter is ready.
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpreter: Option<String>,
    /// The most recent install task while this background process remembers it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskStatus>,
}

pub fn status(state: &RuntimeState) -> Result<ManagedPythonStatus, String> {
    let distribution = current();
    let interpreter = installed_interpreter(state.data_dir());
    let task_id = crate::store_get(state, STORE_KEY.into())?
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let task = task_id.and_then(|id| {
        state
            .tasks
            .lock()
            .ok()?
            .get(&id)
            .map(|record| record.status.clone())
    });
    Ok(ManagedPythonStatus {
        supported: distribution.is_some(),
        version: PYTHON_VERSION.into(),
        download_bytes: distribution.map(|d| d.size),
        installed: interpreter.is_some(),
        interpreter: interpreter.map(|path| path.to_string_lossy().into_owned()),
        task,
    })
}

/// A user-chosen GitHub proxy: `{url}` is replaced with the official asset URL.
/// A template without `{url}` must already be a complete HTTPS address.
pub fn resolve_source(template: &str, distribution: &Distribution) -> Result<String, String> {
    let template = template.trim();
    let resolved = template.replace("{url}", &distribution.official_url());
    if resolved.contains(['{', '}']) {
        return Err("下载来源只支持 {url} 占位符 / The download source only supports {url}".into());
    }
    let url = url::Url::parse(&resolved).map_err(|_| {
        "下载来源必须是完整的 HTTPS 地址 / The download source must be a full HTTPS URL"
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "下载来源必须使用 HTTPS，且不能包含凭据或片段 / The download source must use HTTPS without credentials or fragments"
                .into(),
        );
    }
    Ok(url.to_string())
}

fn mirror_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("mirror redirect limit exceeded")
            } else if attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.error("mirror redirect must remain HTTPS")
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// Starts (or returns the running) install task. `source` is an optional proxy
/// template; the archive digest never changes with the source.
pub fn start(state: Arc<RuntimeState>, source: Option<String>) -> Result<TaskStatus, String> {
    let distribution = current().ok_or(
        "此系统暂不支持一键安装 Python，请自行安装 Python 3.10+ / One-click Python is not available on this system; install Python 3.10+ manually",
    )?;
    let url = match source.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(template) => Some(resolve_source(template, distribution)?),
        None => None,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let task = TaskStatus {
        id: id.clone(),
        kind: TASK_KIND.into(),
        state: "running".into(),
        message: format!("正在准备安装 Python {PYTHON_VERSION}"),
        started_at: now(),
        finished_at: None,
    };
    {
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = tasks
            .values()
            .find(|record| record.status.state == "running" && record.status.kind == TASK_KIND)
        {
            return Ok(existing.status.clone());
        }
        processes::admit_task_logs(&mut tasks, &state.logs, &id)?;
        tasks.insert(
            id.clone(),
            TaskRecord {
                status: task.clone(),
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        let persisted =
            processes::persist_task(&state.database, tasks.get(&id).ok_or("安装任务不存在")?)
                .and_then(|_| {
                    crate::store_set(
                        &state,
                        STORE_KEY.into(),
                        serde_json::json!({ "taskId": id }),
                    )
                });
        if let Err(error) = persisted {
            processes::abandon_unstarted_task(
                &state.database,
                &mut tasks,
                &state.logs,
                &id,
                &error,
            );
            return Err(error);
        }
    }
    tokio::spawn(async move {
        let outcome = install(&state, &id, distribution, url).await;
        if let Ok(mut database) = state.environment_cache.lock() {
            *database = None;
        }
        if let Ok(mut tasks) = state.tasks.lock() {
            if let Some(record) = tasks.get_mut(&id) {
                record.status.finished_at = Some(now());
                let message = match outcome {
                    Ok(path) if !record.cancelled => {
                        record.status.state = "completed".into();
                        format!(
                            "Python {PYTHON_VERSION} 已安装到应用目录，Strata 会自动使用它 / Python {PYTHON_VERSION} is installed for this app: {}",
                            path.display()
                        )
                    }
                    Ok(_) => {
                        record.status.state = "cancelled".into();
                        "已取消安装 Python / Python installation cancelled".into()
                    }
                    Err(error) => {
                        record.status.state = if record.cancelled {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        error
                    }
                };
                record.status.message = message.clone();
                processes::log(&state.logs, &id, &record.status.state, message);
                let _ = processes::persist_task(&state.database, record);
                let _ = processes::persist_task_logs(&state.database, &state.logs, &id);
            }
        }
    });
    Ok(task)
}

async fn install(
    state: &Arc<RuntimeState>,
    id: &str,
    distribution: &'static Distribution,
    mirror: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(existing) = installed_interpreter(state.data_dir()) {
        if python_probe(&existing, &[]).is_some() {
            progress(state, id, "已存在经过校验的应用内 Python，无需重新下载")?;
            return Ok(existing);
        }
    }
    let size = crate::byte_size::human_bytes(distribution.size);
    progress(
        state,
        id,
        format!(
            "正在下载 Python {PYTHON_VERSION}（python-build-standalone {PBS_RELEASE}，{size}）{}",
            if mirror.is_some() {
                "，通过所选代理"
            } else {
                ""
            }
        ),
    )?;
    let archive = match &mirror {
        Some(url) => {
            download_using_client(
                state,
                id,
                url,
                distribution.sha256,
                distribution.size,
                &mirror_client()?,
            )
            .await?
        }
        None => {
            download_release(
                state,
                id,
                &distribution.official_url(),
                distribution.sha256,
                distribution.size,
            )
            .await?
        }
    };
    if fs::metadata(&archive).map_err(|e| e.to_string())?.len() != distribution.size {
        return Err("Python 安装包长度与官方发布不符，已拒绝解包".into());
    }
    progress(state, id, "SHA-256 校验通过，正在解包到应用目录")?;
    let toolchains = owned_directory(state.data_dir(), &["toolchains"])?;
    let staging = tempfile::Builder::new()
        .prefix(".python-")
        .tempdir_in(&toolchains)
        .map_err(|e| e.to_string())?;
    {
        let state = state.clone();
        let id = id.to_owned();
        let destination = staging.path().to_owned();
        tokio::task::spawn_blocking(move || {
            extract(&archive, &destination, || cancelled(&state, &id))
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    cancelled(state, id)?;
    progress(state, id, "正在检查 Python 版本、venv 与 ensurepip")?;
    python_probe(&interpreter_in(staging.path()), &[])
        .ok_or("解包后的 Python 无法运行或缺少 venv/ensurepip；已保留系统原样，可重试")?;
    let marker = Marker {
        version: PYTHON_VERSION.into(),
        release: PBS_RELEASE.into(),
        target: distribution.target.into(),
        sha256: distribution.sha256.into(),
        installed_at: now(),
    };
    fs::write(
        staging.path().join(MARKER),
        serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let destination = toolchains.join(directory_name());
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("应用内 Python 目录被替换或重定向，拒绝覆盖".into());
        }
        // An earlier, unverifiable copy under the app's own fixed name.
        let aside = toolchains.join(format!(".python-old-{}", uuid::Uuid::new_v4()));
        fs::rename(&destination, &aside).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&aside);
    }
    let staged = staging.keep();
    fs::rename(&staged, &destination).map_err(|e| {
        let _ = fs::remove_dir_all(&staged);
        e.to_string()
    })?;
    let interpreter = interpreter_in(&destination);
    python_probe(&interpreter, &[]).ok_or("Python 移入应用目录后无法通过检查，请重试")?;
    Ok(interpreter)
}

/// Lexically resolve a symlink target relative to its own directory and
/// require it to stay inside the archive's `python/` tree.
fn link_stays_inside(entry: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut resolved: Vec<_> = entry
        .parent()
        .map(|parent| parent.components().collect())
        .unwrap_or_default();
    for component in target.components() {
        match component {
            Component::Normal(_) => resolved.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    resolved.len() >= 2 && resolved.first() == Some(&Component::Normal("python".as_ref()))
}

fn safe_relative(name: &str) -> Result<PathBuf, String> {
    let name = name.trim_start_matches("./");
    if name.is_empty() || name.starts_with('/') || name.contains(['\\', '\0']) || name.len() > 400 {
        return Err(format!("Python 安装包含不安全路径：{name}"));
    }
    let path = PathBuf::from(name.trim_end_matches('/'));
    let mut components = path.components();
    if components.next() != Some(Component::Normal("python".as_ref())) {
        return Err(format!("Python 安装包根目录不是 python/：{name}"));
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Python 安装包含不安全路径：{name}"));
    }
    Ok(path)
}

/// Extract a python-build-standalone `install_only` archive. Only regular files,
/// directories and in-tree relative symlinks are accepted; setuid/setgid and
/// group/other write bits are dropped.
pub(crate) fn extract(
    archive: &Path,
    destination: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(GzDecoder::new(
        File::open(archive).map_err(|e| e.to_string())?,
    ));
    let mut names = HashSet::new();
    let mut total = 0u64;
    for (index, entry) in archive.entries().map_err(|e| e.to_string())?.enumerate() {
        if index % 64 == 0 {
            check()?;
        }
        if index >= MAX_ENTRIES {
            return Err("Python 安装包文件数超过安全上限".into());
        }
        let mut entry = entry.map_err(|e| format!("Python 安装包损坏：{e}"))?;
        let kind = entry.header().entry_type();
        if matches!(
            kind,
            tar::EntryType::XGlobalHeader | tar::EntryType::XHeader
        ) {
            continue;
        }
        let raw = entry.path().map_err(|e| e.to_string())?;
        let relative = safe_relative(&raw.to_string_lossy())?;
        if !names.insert(relative.clone()) {
            return Err("Python 安装包含重复路径".into());
        }
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match kind {
            tar::EntryType::Directory => {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            }
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                let size = entry.size();
                total = total
                    .checked_add(size)
                    .filter(|total| *total <= MAX_EXPANDED)
                    .ok_or("Python 安装包展开体积超过安全上限")?;
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(|e| format!("无法写入 {}：{e}", relative.display()))?;
                let copied = std::io::copy(&mut (&mut entry).take(size), &mut output)
                    .map_err(|e| e.to_string())?;
                if copied != size {
                    return Err("Python 安装包文件长度不一致".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = entry.header().mode().unwrap_or(0o644) & 0o755;
                    fs::set_permissions(&target, fs::Permissions::from_mode(mode | 0o600))
                        .map_err(|e| e.to_string())?;
                }
            }
            tar::EntryType::Symlink => {
                let link = entry
                    .link_name()
                    .map_err(|e| e.to_string())?
                    .ok_or("Python 安装包的链接没有目标")?
                    .into_owned();
                if !link_stays_inside(&relative, &link) {
                    return Err(format!(
                        "Python 安装包的链接指向包外：{} -> {}",
                        relative.display(),
                        link.display()
                    ));
                }
                #[cfg(unix)]
                std::os::unix::fs::symlink(&link, &target).map_err(|e| e.to_string())?;
                #[cfg(not(unix))]
                return Err("此系统不解包 Python 链接".into());
            }
            _ => {
                return Err(format!(
                    "Python 安装包含不支持的条目类型：{}",
                    relative.display()
                ))
            }
        }
    }
    check()?;
    if !interpreter_in(destination).exists() {
        return Err("Python 安装包缺少 python/bin/python3".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn pins_cover_macos_and_glibc_linux_only() {
        let mac_arm = distribution("macos", "aarch64", false).unwrap();
        // Same build and digest as upstream Strata setup.sh.
        assert_eq!(
            mac_arm.official_url(),
            "https://github.com/astral-sh/python-build-standalone/releases/download/20261009/cpython-3.12.15%2B20261009-aarch64-apple-darwin-install_only.tar.gz"
        );
        assert_eq!(
            mac_arm.sha256,
            "83dcb04777c798bd95f3687acf9ae84b09860272ee6bdfb05be8bcf9447f75b8"
        );
        assert!(distribution("macos", "x86_64", false).is_some());
        assert!(distribution("linux", "x86_64", false).is_some());
        assert!(distribution("linux", "aarch64", false).is_some());
        assert!(distribution("linux", "x86_64", true).is_none());
        assert!(distribution("windows", "x86_64", false).is_none());
        for (_, _, d) in &DISTRIBUTIONS {
            assert_eq!(d.sha256.len(), 64);
            assert!(d.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            assert!(d.size > 20_000_000 && d.size < 80_000_000);
        }
    }

    #[test]
    fn proxy_templates_wrap_the_official_url_and_reject_unsafe_sources() {
        let d = distribution("macos", "aarch64", false).unwrap();
        assert_eq!(
            resolve_source("https://gh-proxy.org/{url}", d).unwrap(),
            format!("https://gh-proxy.org/{}", d.official_url())
        );
        assert_eq!(
            resolve_source("https://mirror.example/python.tar.gz", d).unwrap(),
            "https://mirror.example/python.tar.gz"
        );
        for bad in [
            "http://gh-proxy.org/{url}",
            "https://user:pw@gh-proxy.org/{url}",
            "https://gh-proxy.org/{asset}",
            "https://gh-proxy.org/{url}#x",
            "not a url",
        ] {
            assert!(resolve_source(bad, d).is_err(), "{bad}");
        }
    }

    #[test]
    fn links_must_stay_inside_the_python_tree() {
        let entry = Path::new("python/bin/python3");
        assert!(link_stays_inside(entry, Path::new("python3.12")));
        assert!(link_stays_inside(
            Path::new("python/share/terminfo/1/1178"),
            Path::new("../a/adm1178")
        ));
        assert!(!link_stays_inside(entry, Path::new("/usr/bin/python3")));
        assert!(!link_stays_inside(entry, Path::new("../../../etc/passwd")));
        assert!(!link_stays_inside(entry, Path::new("../..")));
    }

    fn archive(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> tempfile::NamedTempFile {
        let mut builder = tar::Builder::new(Vec::new());
        build(&mut builder);
        let bytes = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&bytes).unwrap();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&gz.finish().unwrap()).unwrap();
        file
    }

    fn file(builder: &mut tar::Builder<Vec<u8>>, path: &str, mode: u32, data: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        builder.append_data(&mut header, path, data).unwrap();
    }

    fn link(builder: &mut tar::Builder<Vec<u8>>, path: &str, target: &str) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        builder.append_link(&mut header, path, target).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn extracts_install_only_layout_and_strips_privileged_bits() {
        use std::os::unix::fs::PermissionsExt;
        let input = archive(|b| {
            file(b, "python/bin/python3.12", 0o4777, b"#!/bin/sh\n");
            link(b, "python/bin/python3", "python3.12");
            file(b, "python/lib/python3.12/venv/__init__.py", 0o644, b"");
        });
        let out = tempfile::tempdir().unwrap();
        extract(input.path(), out.path(), || Ok(())).unwrap();
        let real = out.path().join("python/bin/python3.12");
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o7777,
            0o755
        );
        assert_eq!(
            fs::read_link(out.path().join("python/bin/python3")).unwrap(),
            PathBuf::from("python3.12")
        );
    }

    #[test]
    fn rejects_escapes_foreign_roots_hardlinks_and_missing_interpreter() {
        type Build = Box<dyn FnOnce(&mut tar::Builder<Vec<u8>>)>;
        let cases: Vec<Build> = vec![
            Box::new(|b| link(b, "python/bin/python3", "/usr/bin/python3")),
            Box::new(|b| link(b, "python/evil", "../../outside")),
            Box::new(|b| file(b, "other/bin/python3", 0o755, b"")),
            Box::new(|b| {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Link);
                header.set_size(0);
                b.append_link(&mut header, "python/bin/python3", "python/bin/x")
                    .unwrap();
            }),
            Box::new(|b| file(b, "python/lib/only.py", 0o644, b"")),
        ];
        for build in cases {
            let input = archive(build);
            let out = tempfile::tempdir().unwrap();
            assert!(extract(input.path(), out.path(), || Ok(())).is_err());
        }
        let input = archive(|b| file(b, "python/bin/python3", 0o755, b""));
        let out = tempfile::tempdir().unwrap();
        assert!(extract(input.path(), out.path(), || Err("取消".into()))
            .unwrap_err()
            .contains("取消"));
    }

    /// Real-archive check: `STRATA_PBS_ARCHIVE=/path/cpython-…-install_only.tar.gz
    /// cargo test -p strata-runtime-core managed_python::tests::real -- --ignored`
    #[test]
    #[ignore]
    fn real_archive_extracts_and_passes_the_install_probe() {
        let archive = PathBuf::from(std::env::var("STRATA_PBS_ARCHIVE").unwrap());
        let d = current().unwrap();
        assert_eq!(super::super::file_hash(&archive).unwrap(), d.sha256);
        let out = tempfile::tempdir().unwrap();
        extract(&archive, out.path(), || Ok(())).unwrap();
        let python = python_probe(&interpreter_in(out.path()), &[]).unwrap();
        assert!(python.starts_with(&*dunce::canonicalize(out.path()).unwrap().to_string_lossy()));
    }

    /// Live end-to-end install over the network (optional proxy template):
    /// `STRATA_PBS_SOURCE='https://gh-proxy.org/{url}' cargo test -p strata-runtime-core
    /// managed_python::tests::live -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_install_is_used_by_runtime_preparation() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let task = start(state.clone(), std::env::var("STRATA_PBS_SOURCE").ok()).unwrap();
        let finished = loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let current = status(&state).unwrap().task.unwrap();
            assert_eq!(current.id, task.id);
            if current.state != "running" {
                break current;
            }
        };
        assert_eq!(finished.state, "completed", "{}", finished.message);
        let status = status(&state).unwrap();
        assert!(status.installed);
        let chosen = super::super::find_python(state.data_dir()).unwrap();
        assert!(chosen.contains(&directory_name()), "{chosen}");
        assert!(crate::cached_environment(&state).python_managed);
    }

    #[test]
    fn traversal_names_are_rejected_before_writing() {
        for name in ["python/../x", "/python/bin", "python\\bin", "x/python"] {
            assert!(safe_relative(name).is_err(), "{name}");
        }
        assert!(safe_relative("./python/bin/python3").is_ok());
    }

    #[test]
    fn installed_interpreter_requires_matching_marker() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        assert!(installed_interpreter(state.data_dir()).is_none());
        let Some(d) = current() else { return };
        let dir = owned_directory(state.data_dir(), &["toolchains"])
            .unwrap()
            .join(directory_name());
        fs::create_dir_all(dir.join("python/bin")).unwrap();
        fs::write(dir.join("python/bin/python3"), b"").unwrap();
        assert!(installed_interpreter(state.data_dir()).is_none());
        let marker = |sha: &str| {
            serde_json::json!({"version": PYTHON_VERSION, "release": PBS_RELEASE, "target": d.target, "sha256": sha, "installedAt": 1}).to_string()
        };
        fs::write(dir.join(MARKER), marker(&"0".repeat(64))).unwrap();
        assert!(installed_interpreter(state.data_dir()).is_none());
        fs::write(dir.join(MARKER), marker(d.sha256)).unwrap();
        assert_eq!(
            installed_interpreter(state.data_dir()).unwrap(),
            dir.join("python/bin/python3")
        );
    }
}
