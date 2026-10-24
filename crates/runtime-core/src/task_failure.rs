//! A failed command task explains itself: the real cause from the last log lines,
//! classified, instead of Rust's `Some(1)` exit-code Debug text.
use crate::processes::Logs;

/// The last lines a task logged, oldest first.
pub fn recent_lines(logs: &Logs, id: &str, limit: usize) -> Vec<String> {
    let Ok(all) = logs.lock() else {
        return Vec::new();
    };
    let Some(entries) = all.get(id) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = entries
        .iter()
        .rev()
        .take(limit)
        .flat_map(|entry| {
            entry
                .message
                .lines()
                .rev()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    lines.reverse();
    lines
}

pub fn exit_text(exit_code: Option<i32>) -> String {
    match exit_code {
        Some(code) => format!("退出码 {code}"),
        None => "进程被终止，没有退出码".into(),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    Network,
    Disk,
    Python,
    Checksum,
    /// `--gguf-dir`'s own file failed its size or SHA-256 check: upstream leaves it in
    /// place, so retrying alone fails again.
    KeptFile,
    Conversion,
    Gpu,
    Other,
}

impl Kind {
    fn title(&self) -> &'static str {
        match self {
            Kind::Network => "网络或下载失败",
            Kind::Disk => "磁盘空间不足或无法写入",
            Kind::Python => "Python 运行环境不完整",
            Kind::Checksum | Kind::KeptFile => "文件校验未通过",
            Kind::Conversion => "模型转换失败",
            Kind::Gpu => "显卡或驱动不满足要求",
            Kind::Other => "准备脚本报错",
        }
    }

    fn advice(&self) -> &'static str {
        match self {
            Kind::Network => "请检查网络，或在设置中切换模型下载源后重试；已下载的部分会保留",
            Kind::Disk => "请释放磁盘空间或更换模型目录后重试",
            Kind::Python => "请在 Strata 引擎页修复或重新安装运行时后重试",
            Kind::Checksum => "重试会重新下载该文件",
            Kind::KeptFile => "这个分片和官方发布的文件不一致（多半是下载或复制时损坏），Strata 不会自动删除它，直接重试还会失败；请先删除这个文件（和同名的 .done 文件）再重试，会重新下载",
            Kind::Conversion => "请确认磁盘空间充足后重试；仍失败请把任务日志发给开发者",
            Kind::Gpu => "请按提示检查显卡驱动后重试",
            Kind::Other => "请按上面的提示处理后重试",
        }
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

pub fn classify(text: &str) -> Kind {
    let lower = text.to_ascii_lowercase();
    if contains_any(
        &lower,
        &[
            "no space left",
            "disk space",
            "errno 28",
            "cannot write",
            "磁盘空间",
        ],
    ) {
        Kind::Disk
    } else if contains_any(
        &lower,
        &[
            "does not match the published",
            "your file was left as it is",
        ],
    ) {
        Kind::KeptFile
    } else if contains_any(&lower, &["sha-256", "sha256", "checksum"]) {
        Kind::Checksum
    } else if contains_any(
        &lower,
        &[
            "cannot reach",
            "could not finish downloading",
            "download keeps stopping",
            "changed on the server",
            "connection",
            "timed out",
            "timeout",
            "urlopen error",
            "ssl",
            "getaddrinfo",
            "name or service not known",
            "temporary failure in name resolution",
            "http error",
            "proxyerror",
            "hugging face",
            "huggingface",
            "modelscope",
            "pypi",
            "无法连接",
            "下载失败",
        ],
    ) {
        Kind::Network
    } else if contains_any(
        &lower,
        &[
            "no module named",
            "modulenotfounderror",
            "python was not found",
            "is not recognized as an internal or external command",
            "needs pytorch",
            "pip install",
            "lacks ",
        ],
    ) {
        Kind::Python
    } else if contains_any(&lower, &["gguf", "convert", "pack ", "shard", "tensor"]) {
        Kind::Conversion
    } else if contains_any(
        &lower,
        &["gpu", "cuda", "hip ", "rocm", "nvidia", "driver", "vulkan"],
    ) {
        Kind::Gpu
    } else {
        Kind::Other
    }
}

fn noise(line: &str) -> bool {
    let line = line.trim();
    line.is_empty()
        || line.starts_with("Setup stopped.")
        || line
            .chars()
            .all(|c| matches!(c, '-' | '=' | '*' | '─' | '.'))
}

/// The upstream `[X]` line and its hint, else a traceback's last line, else the last
/// meaningful line.
pub fn cause(lines: &[String]) -> Option<String> {
    if let Some(index) = lines
        .iter()
        .rposition(|line| line.trim_start().starts_with("[X]"))
    {
        let mut text = lines[index].trim_start()[3..].trim().to_owned();
        if let Some(hint) = lines.get(index + 1).filter(|line| {
            !noise(line) && line.starts_with(' ') && !line.trim_start().starts_with("[X]")
        }) {
            text = format!("{text}（{}）", hint.trim());
        }
        return Some(text);
    }
    if lines
        .iter()
        .any(|line| line.starts_with("Traceback (most recent call last)"))
    {
        if let Some(last) = lines
            .iter()
            .rev()
            .find(|line| !line.starts_with(' ') && !noise(line) && line.contains(':'))
        {
            return Some(last.trim().to_owned());
        }
    }
    lines
        .iter()
        .rev()
        .find(|line| !noise(line))
        .map(|line| line.trim().to_owned())
}

/// `description` is the step's own name, e.g. "模型准备".
pub fn explain(description: &str, exit_code: Option<i32>, lines: &[String]) -> String {
    let exit = exit_text(exit_code);
    let Some(cause) = cause(lines) else {
        return format!("{description}失败（{exit}），日志里没有更多信息；请查看任务日志后重试");
    };
    let cause: String = if cause.chars().count() > 240 {
        format!("{}…", cause.chars().take(240).collect::<String>())
    } else {
        cause
    };
    let kind = classify(&cause);
    format!("{}：{cause}。{}（{exit}）", kind.title(), kind.advice())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    #[test]
    fn upstream_fail_line_and_hint_become_the_message() {
        let log = lines("Downloading model…\n\n  [X]  cannot reach huggingface.co (timed out)\n       check the connection, or set HF_ENDPOINT\n\nSetup stopped. Fix the item above and run it again - everything already done is kept and skipped.");
        let text = explain("模型准备", Some(1), &log);
        assert_eq!(text, "网络或下载失败：cannot reach huggingface.co (timed out)（check the connection, or set HF_ENDPOINT）。请检查网络，或在设置中切换模型下载源后重试；已下载的部分会保留（退出码 1）");
        assert!(!text.contains("Some("));
    }

    #[test]
    fn categories_cover_the_common_failures() {
        assert_eq!(
            classify("cannot write Qwen.gguf.part: [Errno 28] No space left on device"),
            Kind::Disk
        );
        assert_eq!(
            classify("model.gguf has the wrong SHA-256 (abc, expected def): deleted"),
            Kind::Checksum
        );
        assert_eq!(
            classify("ModuleNotFoundError: No module named 'numpy'"),
            Kind::Python
        );
        assert_eq!(
            classify("model-00001.gguf is not a whole GGUF shard (bad magic)"),
            Kind::Conversion
        );
        assert_eq!(classify("none of your GPUs can run Strata"), Kind::Gpu);
        assert_eq!(classify("something odd happened"), Kind::Other);
    }

    #[test]
    fn a_kept_file_that_fails_its_sha256_says_to_delete_it_not_just_retry() {
        // A user's report (v0.2.18): --gguf-dir leaves the damaged shard in place, so
        // "重试会重新下载" was wrong and every retry failed the same way.
        let log = lines("  checking Qwen3.8-Flash-Next-UD-Q6_K_XL-00004-of-00006.gguf (SHA-256, 49.8 GB) ...\n  [X]  Qwen3.8-Flash-Next-UD-Q6_K_XL-00004-of-00006.gguf does not match the published file (SHA-256 6f9826d42d8befc7f31321a13031c57b67efcd27a4e5a113a5ebe5a81f0e44cf, expected 0ea4b599880a5a52fcd9c188ba1443f646c69c96571904ddbd6a79246a01a997)\n       it may be damaged or another version; your file was left as it is. Copy the whole published file into the folder\n");
        let text = explain("模型准备", Some(1), &log);
        assert!(
            text.starts_with("文件校验未通过：Qwen3.8-Flash-Next-UD-Q6_K_XL-00004-of-00006.gguf")
        );
        assert!(text.contains("请先删除这个文件"));
        assert!(!text.contains("重试会重新下载该文件"));
        assert_eq!(
            classify("x.gguf is 10 bytes; the published file is 20 (it may be cut short or another version; your file was left as it is. Copy the whole published file into the folder)"),
            Kind::KeptFile
        );
    }

    #[test]
    fn traceback_uses_its_last_line() {
        let log = lines("Traceback (most recent call last):\n  File \"setup.py\", line 3, in <module>\n    import numpy\nModuleNotFoundError: No module named 'numpy'");
        assert!(explain("模型准备", Some(1), &log)
            .starts_with("Python 运行环境不完整：ModuleNotFoundError: No module named 'numpy'。"));
    }

    #[test]
    fn missing_logs_and_exit_codes_read_plainly() {
        assert_eq!(
            explain("模型准备", None, &[]),
            "模型准备失败（进程被终止，没有退出码），日志里没有更多信息；请查看任务日志后重试"
        );
        assert_eq!(exit_text(Some(3)), "退出码 3");
    }
}
