//! Read the flags the installed engine itself documents (`<exe> --help`),
//! so the startup form follows the real binary instead of a pinned catalog.
//! `--help` exits in upstream's argv loop before any GPU or model work.
use crate::{processes, storage, types::ServiceProfile};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineHelp {
    pub flags: Vec<String>,
    pub source: String,
}

/// Every `--flag` token in the help text; mentions inside descriptions count as documented.
pub fn parse_flags(text: &str) -> BTreeSet<String> {
    let mut flags = BTreeSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        let boundary = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'-');
        if boundary
            && bytes[i] == b'-'
            && bytes[i + 1] == b'-'
            && bytes[i + 2].is_ascii_alphanumeric()
        {
            let start = i;
            i += 2;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
                i += 1;
            }
            let flag = text[start..i].trim_end_matches('-');
            if flag.len() > 2 && flag.len() <= 64 {
                flags.insert(flag.to_ascii_lowercase());
            }
        } else {
            i += 1;
        }
    }
    flags
}

pub fn engine_path(profile: &ServiceProfile) -> Result<PathBuf, String> {
    let root = processes::runtime_dir(profile)?;
    let config = storage::read(profile)?;
    let exe = config["exe"].as_str().ok_or("配置缺少 exe")?;
    let cwd = config["cwd"]
        .as_str()
        .map(PathBuf::from)
        .map(|c| if c.is_absolute() { c } else { root.join(c) })
        .unwrap_or_else(|| root.clone());
    let path = if Path::new(exe).is_absolute() {
        PathBuf::from(exe)
    } else {
        cwd.join(exe)
    };
    if !path.is_file() {
        return Err("引擎可执行文件不存在，无法读取 --help".into());
    }
    Ok(path)
}

pub fn run_help(exe: &Path) -> Result<EngineHelp, String> {
    let mut command = Command::new(exe);
    command
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    processes::hidden(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行引擎 --help：{e}"))?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = (&mut out).take(MAX_OUTPUT as u64).read_to_end(&mut text);
        text
    });
    let error_reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = (&mut err).take(MAX_OUTPUT as u64).read_to_end(&mut text);
        text
    });
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if start.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("引擎 --help 超时".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut text = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(
        &error_reader.join().unwrap_or_default(),
    ));
    let flags = parse_flags(&text);
    if flags.len() < 3 {
        return Err("引擎 --help 未输出可识别的参数列表".into());
    }
    Ok(EngineHelp {
        flags: flags.into_iter().collect(),
        source: "engine --help".into(),
    })
}

pub fn flags(profile: &ServiceProfile) -> Result<EngineHelp, String> {
    run_help(&engine_path(profile)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_upstream_usage_layout() {
        let text = "strata generate --pack DIR --tokens \"1,2,3\" [options]\n\n  --gpu LIST   run on these GPUs\n  --ple-gguf PATH  with --native, the shard\n  --kv fp16|int8  storage\n  --batch N    sequences at once; see --batch-mtp\n  a-b--not-a-flag, ---x, --\n";
        let flags = parse_flags(text);
        for flag in [
            "--pack",
            "--tokens",
            "--gpu",
            "--ple-gguf",
            "--native",
            "--kv",
            "--batch",
            "--batch-mtp",
        ] {
            assert!(flags.contains(flag), "{flag}");
        }
        assert!(!flags.iter().any(|f| f.contains("not-a-flag") || f == "--"));
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_real_executable_and_reads_stderr_usage() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("strata");
        std::fs::write(&exe, "#!/bin/sh\n[ \"$1\" = --help ] || exit 9\necho '  --gpu LIST' >&2\necho '  --batch N' >&2\necho '  --vram-elastic' >&2\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let help = run_help(&exe).unwrap();
        assert_eq!(help.flags, vec!["--batch", "--gpu", "--vram-elastic"]);
        std::fs::write(&exe, "#!/bin/sh\necho nothing\n").unwrap();
        assert!(run_help(&exe).is_err());
    }
}
