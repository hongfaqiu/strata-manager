//! Before the official installer (setup.py) runs, fetch what its step 4 ("the Strata engine")
//! would otherwise download silently from GitHub, through the user's download route
//! (automatic speed test by default), so the step shows bytes and a source instead of a
//! frozen log. Nothing upstream is changed: files go exactly where setup.py looks.
//!
//! - llama.cpp source: setup.py's `get_llama_cpp()` skips its download when
//!   `third_party/llama.cpp-<sha7>.zip` and its `.done` finish mark exist. Manager downloads the
//!   pinned commit's archive, checks the SHA-256 recorded here, then writes both.
//! - The ready-made engine: Manager's own installs already lay down `engine/` (setup.py says
//!   "ready-made engine already installed"); when it is missing or too old the log says plainly
//!   that the installer will fetch it from GitHub.
//!
//! Any failure here only falls back to setup.py's own download, with a clear notice.
use crate::{installation, processes, runtime_upgrade::download_route, RuntimeState};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// llama.cpp commits setup.py pins, with the SHA-256 and size of GitHub's archive of each.
const LLAMA_ARCHIVES: &[(&str, &str, u64)] = &[(
    "3cf03257f219afbe7334045ff7c6a06ac68c627d",
    "cbe23c594282ead2937abb3f008e51fcec4609d9256652fff42c7cc1c21ea47b",
    39_564_399,
)];

/// Prefix of every notice that the installer will download by itself (the app shows a hint).
pub const FALLBACK_PREFIX: &str = "预下载未完成";
/// Prefix of the prefetch progress lines.
pub const PREFIX: &str = "引擎预下载";

fn assignment<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    source.lines().find_map(|line| {
        let rest = line.strip_prefix(name)?.trim_start().strip_prefix('=')?;
        Some(rest.split('#').next().unwrap_or_default().trim())
    })
}

/// `LLAMA_CPP_COMMIT = "<40 hex>"` from setup.py.
pub fn llama_commit(setup_source: &str) -> Option<String> {
    let value = assignment(setup_source, "LLAMA_CPP_COMMIT")?.trim_matches('"');
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

/// `MIN_ENGINE = (0, 1, 46)` from setup.py.
pub fn min_engine(setup_source: &str) -> Option<Vec<u32>> {
    let value = assignment(setup_source, "MIN_ENGINE")?;
    let inner = value.strip_prefix('(')?.split(')').next()?;
    let parts: Option<Vec<u32>> = inner
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.parse().ok())
        .collect();
    parts.filter(|parts| !parts.is_empty())
}

fn version_numbers(version: &str) -> Vec<u32> {
    version
        .split('.')
        .take(4)
        .filter_map(|part| part.parse().ok())
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Llama {
    /// Unpacked already, or the archive and its finish mark are in place.
    Ready,
    Fetch {
        url: String,
        sha256: &'static str,
        size: u64,
        archive: PathBuf,
    },
    /// setup.py pins a commit this Manager has no checksum for.
    Unknown(String),
}

pub fn llama_plan(root: &Path, setup_source: &str) -> Option<Llama> {
    let commit = llama_commit(setup_source)?;
    let third_party = root.join("third_party");
    let unpacked = third_party.join("llama.cpp");
    let archive = third_party.join(format!("llama.cpp-{}.zip", &commit[..7]));
    if (unpacked.join("ggml").join("CMakeLists.txt").exists() && unpacked.join("gguf-py").is_dir())
        || (archive.is_file() && done_mark(&archive).exists())
    {
        return Some(Llama::Ready);
    }
    Some(
        match LLAMA_ARCHIVES.iter().find(|(known, _, _)| *known == commit) {
            Some((_, sha256, size)) => Llama::Fetch {
                url: format!("https://github.com/ggml-org/llama.cpp/archive/{commit}.zip"),
                sha256,
                size: *size,
                archive,
            },
            None => Llama::Unknown(commit),
        },
    )
}

fn done_mark(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".done");
    path.with_file_name(name)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Engine {
    Ready(String),
    Missing,
    Old(String),
    /// Compiled on this computer: setup.py checks and rebuilds it itself (no download).
    Local,
}

pub fn engine_state(root: &Path, setup_source: &str) -> Engine {
    let engine = root.join("engine");
    let exe = engine.join(if cfg!(windows) {
        "strata.exe"
    } else {
        "strata"
    });
    let Some(build) = fs::read_to_string(engine.join("BUILD.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    else {
        return Engine::Missing;
    };
    if !exe.is_file() {
        return Engine::Missing;
    }
    let version = match &build["version"] {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if build["source"].as_str() == Some("local") {
        return Engine::Local;
    }
    let minimum = min_engine(setup_source).unwrap_or_else(|| vec![0, 1, 46]);
    if version_numbers(&version) >= minimum {
        Engine::Ready(version)
    } else {
        Engine::Old(version)
    }
}

fn say(state: &RuntimeState, id: &str, level: &str, message: String) {
    processes::log(&state.logs, id, level, message);
}

fn place(cache: &Path, archive: &Path) -> Result<(), String> {
    let parent = archive.parent().ok_or("third_party 目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(
        "{}.strata-manager.tmp",
        archive.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::copy(cache, &temporary).map_err(|e| e.to_string())?;
    fs::rename(&temporary, archive).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        e.to_string()
    })?;
    // setup.py's mark(): any text; its own marks hold the time.
    fs::write(done_mark(archive), "strata-manager").map_err(|e| e.to_string())
}

/// Runs inside the setup task before setup.py. Only cancelling the task is an error;
/// every other problem is logged and setup.py downloads the file itself.
pub async fn run(state: &RuntimeState, id: &str, root: &Path) -> Result<(), String> {
    let Ok(source) = fs::read_to_string(root.join("setup.py")) else {
        return Ok(());
    };
    say(
        state,
        id,
        "info",
        format!("{PREFIX}：检查第 4 步（Strata 引擎）需要的文件 / Pre-download: checking what step 4 (the Strata engine) needs"),
    );
    match llama_plan(root, &source) {
        None => {}
        Some(Llama::Ready) => say(
            state,
            id,
            "info",
            format!("{PREFIX}：llama.cpp 源码已就绪，安装器将跳过下载 / Pre-download: the llama.cpp source is ready; the installer skips its download"),
        ),
        Some(Llama::Unknown(commit)) => say(
            state,
            id,
            "warn",
            format!(
                "{FALLBACK_PREFIX}：安装器要求的 llama.cpp 版本 {} 尚未登记校验值。安装器将从 GitHub 下载 llama.cpp 源码，可能较慢；可在「下载设置」切换来源 / Pre-download skipped: llama.cpp {} has no recorded checksum yet. The installer downloads the llama.cpp source from GitHub, which may be slow; you can switch the source in Download settings",
                &commit[..7],
                &commit[..7]
            ),
        ),
        Some(Llama::Fetch {
            url,
            sha256,
            size,
            archive,
        }) => {
            let fetched = download_route::download(
                state,
                id,
                ("llama.cpp 源码", "llama.cpp source"),
                &url,
                sha256,
                size,
            )
            .await;
            installation::cancelled(state, id)?;
            match fetched.and_then(|(cache, label)| place(&cache, &archive).map(|()| label)) {
                Ok(label) => say(
                    state,
                    id,
                    "info",
                    format!("{PREFIX}：llama.cpp 源码已从 {label} 下载并通过 SHA-256 校验，安装器将跳过下载 / Pre-download: llama.cpp source downloaded from {label} and SHA-256 verified; the installer skips its download"),
                ),
                Err(error) => say(
                    state,
                    id,
                    "warn",
                    format!("{FALLBACK_PREFIX}：没能预先下载 llama.cpp 源码（{error}）。正在从 GitHub 下载引擎包，可能较慢，可在「下载设置」切换来源 / Pre-download failed for the llama.cpp source. Downloading the engine package from GitHub, which may be slow; you can switch the source in Download settings"),
                ),
            }
        }
    }
    match engine_state(root, &source) {
        Engine::Ready(version) => say(
            state,
            id,
            "info",
            format!("{PREFIX}：Strata 引擎 {version} 已安装，安装器不会再下载 / Pre-download: Strata engine {version} is installed; the installer will not download it"),
        ),
        Engine::Local => {}
        missing => {
            let (zh, en) = match &missing {
                Engine::Old(version) => (
                    format!("已安装的引擎 {version} 低于安装器要求"),
                    format!("the installed engine {version} is older than the installer needs"),
                ),
                _ => ("本机还没有预制引擎".to_owned(), "no ready-made engine yet".to_owned()),
            };
            say(
                state,
                id,
                "warn",
                format!("{FALLBACK_PREFIX}：{zh}。正在从 GitHub 下载引擎包，可能较慢，可在「下载设置」切换来源，或先在「Strata 更新」安装引擎 / Pre-download skipped: {en}. Downloading the engine package from GitHub, which may be slow; you can switch the source in Download settings or install the engine from Strata updates first"),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETUP: &str = "LLAMA_CPP_COMMIT = \"3cf03257f219afbe7334045ff7c6a06ac68c627d\"\nMIN_ENGINE = (0, 1, 46)                # comment (1, 2)\n";

    #[test]
    fn reads_the_pins_setup_py_declares() {
        assert_eq!(
            llama_commit(SETUP).as_deref(),
            Some("3cf03257f219afbe7334045ff7c6a06ac68c627d")
        );
        assert_eq!(min_engine(SETUP), Some(vec![0, 1, 46]));
        assert_eq!(llama_commit("LLAMA_CPP_COMMIT = \"main\"\n"), None);
        assert_eq!(min_engine("x = 1\n"), None);
    }

    #[test]
    fn llama_is_fetched_once_into_the_path_setup_py_checks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let Some(Llama::Fetch {
            url, size, archive, ..
        }) = llama_plan(root, SETUP)
        else {
            panic!("expected a fetch");
        };
        assert_eq!(
            url,
            "https://github.com/ggml-org/llama.cpp/archive/3cf03257f219afbe7334045ff7c6a06ac68c627d.zip"
        );
        assert_eq!(size, 39_564_399);
        assert_eq!(
            archive,
            root.join("third_party").join("llama.cpp-3cf0325.zip")
        );
        // What setup.py's download() treats as "already downloaded": the file and <file>.done.
        let cache = root.join("cache.zip");
        fs::write(&cache, b"zip").unwrap();
        place(&cache, &archive).unwrap();
        assert!(root
            .join("third_party")
            .join("llama.cpp-3cf0325.zip.done")
            .is_file());
        assert_eq!(llama_plan(root, SETUP), Some(Llama::Ready));
        // An unpacked tree counts too.
        let other = tempfile::tempdir().unwrap();
        let llama = other.path().join("third_party").join("llama.cpp");
        fs::create_dir_all(llama.join("ggml")).unwrap();
        fs::create_dir_all(llama.join("gguf-py")).unwrap();
        fs::write(llama.join("ggml").join("CMakeLists.txt"), "").unwrap();
        assert_eq!(llama_plan(other.path(), SETUP), Some(Llama::Ready));
        // A commit without a recorded checksum falls back to setup.py.
        let unknown = "LLAMA_CPP_COMMIT = \"0000000000000000000000000000000000000000\"\n";
        assert!(matches!(
            llama_plan(temp.path().join("x").as_path(), unknown),
            Some(Llama::Unknown(_))
        ));
    }

    #[test]
    fn engine_state_matches_setup_py_already_installed_rule() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert_eq!(engine_state(root, SETUP), Engine::Missing);
        let engine = root.join("engine");
        fs::create_dir_all(&engine).unwrap();
        fs::write(
            engine.join(if cfg!(windows) {
                "strata.exe"
            } else {
                "strata"
            }),
            "",
        )
        .unwrap();
        let build = |json: &str| fs::write(engine.join("BUILD.json"), json).unwrap();
        build(r#"{"version":"0.1.46.2","source":"prebuilt"}"#);
        assert_eq!(engine_state(root, SETUP), Engine::Ready("0.1.46.2".into()));
        build(r#"{"version":"0.1.45.3","source":"prebuilt"}"#);
        assert_eq!(engine_state(root, SETUP), Engine::Old("0.1.45.3".into()));
        build(r#"{"version":"0.1.40","source":"local"}"#);
        assert_eq!(engine_state(root, SETUP), Engine::Local);
    }

    /// Live: speed test + llama.cpp archive (about 40 MB) through the real route.
    #[tokio::test]
    #[ignore = "downloads the pinned llama.cpp archive (about 40 MB); run explicitly"]
    async fn live_prefetch_places_the_verified_archive() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = "live-prefetch".to_string();
        crate::processes::register_task_logs(&state.logs, &id).unwrap();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            crate::processes::TaskRecord {
                status: crate::types::TaskStatus {
                    id: id.clone(),
                    kind: "setup".into(),
                    state: "running".into(),
                    message: String::new(),
                    started_at: crate::types::now(),
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        if std::env::var("PREFETCH_OFFICIAL").is_ok() {
            crate::store_set(
                &state,
                crate::runtime_upgrade::github_source::PREFERENCES_KEY.into(),
                serde_json::json!({"mode": "official"}),
            )
            .unwrap();
        }
        let root = temp.path().join("runtime");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("setup.py"), SETUP).unwrap();
        run(&state, &id, &root).await.unwrap();
        for entry in state.logs.lock().unwrap()[id.as_str()].iter() {
            println!("{}", entry.message);
        }
        assert_eq!(llama_plan(&root, SETUP), Some(Llama::Ready));
    }
}
