//! Strata on a Mac without compiling anything.
//!
//! Upstream `setup.py` has two Mac paths. Run plainly it calls `metal/setup_mac.py`, which builds the
//! Metal engine from source with Apple's compiler (Command Line Tools, cmake, ninja, ~5–15 minutes).
//! Run with `STRATA_CONTROL_INSTALL=1` it is the app's path (`mac_control_setup`): it only downloads and
//! prepares the model, writes a run config whose engine is `component:strata-engine`, and builds nothing.
//!
//! Manager already installs the signed prebuilt Metal engine into `<runtime>/engine` before any model is
//! prepared, so on a Mac it runs `setup.py` in Control mode and shows that engine to upstream as a
//! component (`<runtime>/components`, see `component_engine::ensure_managed_view`). Whatever cannot run
//! in Control mode (the Unsloth quantizations, an old source, no verified engine) keeps the source build,
//! which now checks the compiler first and explains its own failure.
use crate::component_engine;
use crate::macos_metal;
use crate::processes::Step;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const MAC_PLATFORM: &str = "macos-arm64";

/// Why a `setup.py` step does not run in Control mode (shown nowhere; tests and the log use it).
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Run in Control mode with these extra environment entries.
    Control(BTreeMap<String, Option<String>>),
    /// Keep the plain `setup.py` (source build on a Mac).
    Compile(&'static str),
    /// Not a Mac setup at all: nothing changes.
    NotApplicable,
}

fn is_setup_step(step: &Step) -> bool {
    step.args.iter().any(|arg| arg == "setup.py")
        && !step.args.iter().any(|arg| arg == "--inspect")
        && step.program != "/bin/sh"
}

fn option<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
}

/// The families and quantizations upstream's Control mode serves on a Mac: Qwen3.8-Flash-Next and Gyro.
/// The Unsloth quantizations (`UD-*`) only exist on the source-build path.
fn control_serves(args: &[String]) -> bool {
    let family_ok = option(args, "--family").is_none_or(|family| matches!(family, "qwen" | "gyro"));
    let model_ok = option(args, "--model").is_none_or(|model| !model.starts_with("UD-"));
    family_ok && model_ok
}

/// The source understands Control mode on a Mac (Strata 0.2.0 and later).
fn source_supports_control(root: &Path) -> bool {
    let Ok(source) = fs::read_to_string(root.join("setup.py")) else {
        return false;
    };
    source.contains("STRATA_CONTROL_INSTALL") && source.contains("def mac_control_setup")
}

/// Manager's own verified engine is in place, at the pinned version, with its component manifest.
fn managed_engine_ready(root: &Path) -> bool {
    component_engine::managed_package(root, MAC_PLATFORM).is_some()
        && !macos_metal::managed_metal_install_outdated(&root.join(macos_metal::METAL_ENGINE_DIR))
}

fn string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The `--family` choices of the Mac installer (`metal/setup_mac.py`) in this runtime, read from its
/// `argparse` line. `None` when the file or the line cannot be read; callers then decide nothing.
fn mac_installer_families(root: &Path) -> Option<Vec<String>> {
    let source = fs::read_to_string(root.join("metal").join("setup_mac.py")).ok()?;
    let line = source
        .lines()
        .find(|line| line.contains("\"--family\"") && line.contains("choices=["))?;
    let list = line.split_once("choices=[")?.1.split_once(']')?.0;
    let families: Vec<String> = list
        .split(',')
        .map(|item| item.trim().trim_matches(|c| c == '"' || c == '\''))
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect();
    (!families.is_empty()).then_some(families)
}

/// Refuse up front a model family this runtime's Mac installer does not offer (DeepSeek-V4.1-Flash in
/// Strata 0.2.x): run plainly, `setup.py` hands it to `metal/setup_mac.py`, which would first make the
/// user pass the compiler check and then stop at its own argument check. Families Control mode serves
/// never reach that installer and stay allowed; an unreadable installer decides nothing.
pub fn unsupported_family_on_mac(
    root: &Path,
    family: &str,
    os: &str,
    arch: &str,
) -> Option<String> {
    if !macos_metal::metal_engine_supported(os, arch) {
        return None;
    }
    if matches!(family, "qwen" | "gyro") && source_supports_control(root) {
        return None;
    }
    let families = mac_installer_families(root)?;
    if families.iter().any(|known| known == family) {
        return None;
    }
    let name = if family == "deepseek41" {
        "DeepSeek-V4.1-Flash"
    } else {
        family
    };
    Some(format!(
        "{name} 暂不支持 Mac：这个版本的 Strata 在 Mac 上只提供 {}（不会为此编译引擎）/ {name} does not run on a Mac in this Strata version",
        families.join("、")
    ))
}

/// Decide how the `setup.py` step of a setup task runs on this host.
pub fn decide(root: &Path, step: &Step, os: &str, arch: &str) -> Decision {
    if !macos_metal::metal_engine_supported(os, arch) || !is_setup_step(step) {
        return Decision::NotApplicable;
    }
    if !control_serves(&step.args) {
        return Decision::Compile("这个模型规格只在源码编译路径上提供");
    }
    if !source_supports_control(root) {
        return Decision::Compile("这个版本的安装器没有免编译模式");
    }
    if !managed_engine_ready(root) {
        return Decision::Compile("没有 Manager 校验过的预制引擎");
    }
    if !Path::new(&step.program).is_file()
        || !crate::discovery::missing_runtime_modules(root, Path::new(&step.program)).is_empty()
    {
        return Decision::Compile("私有 Python 环境还没有准备好");
    }
    let components = match component_engine::ensure_managed_view(root, MAC_PLATFORM) {
        Ok(Some(components)) => components,
        Ok(None) => return Decision::Compile("没有 Manager 校验过的预制引擎"),
        Err(_) => return Decision::Compile("无法把引擎登记为组件"),
    };
    let mut env = BTreeMap::new();
    env.insert("STRATA_CONTROL_INSTALL".to_owned(), Some("1".to_owned()));
    env.insert("STRATA_INSTALL_DIR".to_owned(), Some(string(root)));
    env.insert(
        "STRATA_COMPONENTS_DIR".to_owned(),
        Some(string(&components)),
    );
    Decision::Control(env)
}

/// Whether a `setup.py` step that stays plain really builds the engine: the source build is skipped
/// when this folder already holds a finished one.
fn would_build(root: &Path) -> bool {
    let build = root.join(macos_metal::METAL_BUILD_DIR);
    !(build.join(macos_metal::METAL_ENGINE_BINARY).is_file() && build.join("BUILD.json").is_file())
}

/// Switch every eligible `setup.py` step to Control mode and put the compiler check in front of a plain
/// one that really builds. Other hosts and other steps are returned untouched. Returns how many steps
/// run without compiling.
pub fn prepare_steps(root: &Path, steps: &mut Vec<Step>, os: &str, arch: &str) -> usize {
    let mut control = 0;
    let mut compiles = false;
    for step in steps.iter_mut() {
        match decide(root, step, os, arch) {
            Decision::Control(env) => {
                for (key, value) in env {
                    step.env.entry(key).or_insert(value);
                }
                control += 1;
            }
            Decision::Compile(_) => compiles = true,
            Decision::NotApplicable => {}
        }
    }
    if compiles && would_build(root) {
        steps.insert(0, compiler_preflight(root));
    }
    control
}

/// `xcrun --find clang` and `clang --version`, in the task's own log. The text follows upstream's `[X]`
/// convention, so a failure surfaces as the task's message with its hint.
pub fn compiler_preflight(root: &Path) -> Step {
    const SCRIPT: &str = r#"out=$( { xcrun --find clang && clang --version; } 2>&1 ) || {
  echo "[X]  这台 Mac 上没有可用的 C/C++ 编译器（xcrun --find clang 或 clang --version 失败） / No usable C/C++ compiler on this Mac (xcrun --find clang or clang --version failed)"
  echo "     请在“终端”运行 xcode-select --install 安装命令行工具后重试 / Run xcode-select --install in Terminal to install the Command Line Tools, then try again"
  printf '%s\n' "$out" | head -6
  exit 1
}
echo "编译环境检查通过 / Compiler check passed"
printf '%s\n' "$out" | head -3"#;
    Step {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), SCRIPT.into()],
        cwd: root.to_owned(),
        env: BTreeMap::new(),
    }
}

/// `(keyword in the log, bilingual hint)`, checked against the build log's tail and the task output.
const COMPILER_HINTS: &[(&str, &str)] = &[
    (
        "invalid active developer path",
        "命令行工具缺失或已损坏：请运行 xcode-select --install（或 sudo xcode-select --reset）/ The Command Line Tools are missing or broken: run xcode-select --install (or sudo xcode-select --reset)",
    ),
    (
        "xcrun",
        "xcrun 无法找到编译器：请运行 xcode-select --install，或在“系统设置 → 通用 → 软件更新”里更新命令行工具 / xcrun cannot find the compiler: run xcode-select --install, or update the Command Line Tools in System Settings → General → Software Update",
    ),
    (
        "c compiler identification is unknown",
        "CMake 识别不到 C 编译器：通常是命令行工具与 macOS 版本不匹配，请更新命令行工具（xcode-select --install 或软件更新）/ CMake cannot identify the C compiler: usually the Command Line Tools do not match this macOS; update them (xcode-select --install or Software Update)",
    ),
    (
        "missing metal toolchain",
        "缺少 Metal 工具链：请在终端运行 xcodebuild -downloadComponent MetalToolchain，或改用 Manager 的预制引擎（不需要编译） / The Metal Toolchain is missing: run xcodebuild -downloadComponent MetalToolchain in Terminal, or use Manager's prebuilt engine (no compile needed)",
    ),
    (
        "metal-cpp",
        "metal-cpp 头文件与当前编译器不兼容或下载不完整：更新命令行工具后重试 / The metal-cpp headers do not match this compiler or did not download completely: update the Command Line Tools and retry",
    ),
    (
        "no space left",
        "磁盘空间不足：释放空间后重试 / The disk is full: free some space and retry",
    ),
];

/// The compiler-related hints that apply to `text`, each once.
pub fn compiler_hints(text: &str) -> Vec<&'static str> {
    let lower = text.to_ascii_lowercase();
    let mut hints: Vec<&'static str> = Vec::new();
    for (keyword, hint) in COMPILER_HINTS {
        // "xcrun" only counts alone when the more specific path message did not already explain it.
        if *keyword == "xcrun" && lower.contains("invalid active developer path") {
            continue;
        }
        if lower.contains(keyword) && !hints.contains(hint) {
            hints.push(hint);
        }
    }
    hints
}

/// The last `limit` lines of a text, oldest first, without trailing blank lines.
pub fn tail_lines(text: &str, limit: usize) -> Vec<String> {
    let mut lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(limit);
    lines[start..]
        .iter()
        .map(|line| (*line).to_owned())
        .collect()
}

fn build_log_paths(root: &Path) -> [PathBuf; 2] {
    [
        root.join(macos_metal::METAL_BUILD_DIR).join("build.log"),
        root.join("build-vision.log"),
    ]
}

const LOG_LINES: usize = 30;

/// What to add to a failed setup task's message when the source build ran and failed: the last 30
/// lines of the build log it names, and keyword hints. `None` when no build was involved.
pub fn compile_failure_note(root: &Path, task_lines: &[String]) -> Option<String> {
    let task_text = task_lines.join("\n");
    let lower = task_text.to_ascii_lowercase();
    let preflight = lower.contains("xcode-select --install") && lower.contains("[x]");
    let built = lower.contains("did not build")
        || lower.contains("building the metal engine")
        || lower.contains("building the image encoder")
        || lower.contains("build.log");
    if !built || preflight {
        return None;
    }
    // The log the failing step names ("did not build (see <path>)"); else the engine's own log.
    let named = task_lines.iter().rev().find_map(|line| {
        let start = line.find("(see ")? + 5;
        let end = line[start..].find(')')? + start;
        let path = PathBuf::from(line[start..end].trim());
        path.is_absolute().then_some(path)
    });
    let mut candidates: Vec<PathBuf> = named.into_iter().collect();
    candidates.extend(build_log_paths(root));
    let (path, text) = candidates.into_iter().find_map(|path| {
        // Only a log inside this runtime folder is ever read.
        let inside = dunce::canonicalize(&path)
            .ok()
            .zip(dunce::canonicalize(root).ok())
            .is_some_and(|(path, root)| path.starts_with(root));
        if !inside {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        let tail = &bytes[bytes.len().saturating_sub(64 * 1024)..];
        Some((path, String::from_utf8_lossy(tail).into_owned()))
    })?;
    let tail = tail_lines(&text, LOG_LINES);
    if tail.is_empty() {
        return None;
    }
    let mut note = format!(
        "\n编译日志（{}）最后 {} 行 / Last {} lines of the build log ({}):\n{}",
        path.display(),
        tail.len(),
        tail.len(),
        path.display(),
        tail.join("\n")
    );
    let mut searchable = tail.join("\n");
    searchable.push('\n');
    searchable.push_str(&task_text);
    for hint in compiler_hints(&searchable) {
        note.push_str("\n提示 / Hint: ");
        note.push_str(hint);
    }
    Some(note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// A runtime folder as Manager leaves it on a Mac: Control-capable source, the verified engine,
    /// and a private venv whose python exists (module probing is stubbed by a python that imports).
    fn mac_runtime(root: &Path) {
        write(
            &root.join("setup.py"),
            "STRATA_CONTROL_INSTALL\ndef mac_control_setup(a):\n",
        );
        let manifest = json!({"schema_version": 2, "id": "strata-engine", "name": "strata-engine",
            "version": macos_metal::METAL_ENGINE_VERSION, "platform": MAC_PLATFORM, "backend": "metal",
            "entrypoint": "strata", "build_id": "x", "files": []});
        write(
            &root.join("engine/engine-component.json"),
            &manifest.to_string(),
        );
        write(&root.join("engine/strata"), "engine");
        macos_metal::write_metal_install_marker(&root.join("engine")).unwrap();
        write(&root.join(".venv/bin/python"), "python");
    }

    fn setup_step(root: &Path, extra: &[&str]) -> Step {
        let mut args: Vec<String> = ["-u", "setup.py", "--yes", "--setup"]
            .into_iter()
            .map(String::from)
            .collect();
        args.extend(extra.iter().map(|s| (*s).to_owned()));
        Step {
            program: string(&root.join(".venv/bin/python")),
            args,
            cwd: root.to_owned(),
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn other_hosts_and_other_steps_are_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        mac_runtime(root);
        let step = setup_step(root, &["--family", "qwen", "--model", "Q2_0"]);
        for (os, arch) in [
            ("windows", "x86_64"),
            ("linux", "x86_64"),
            ("macos", "x86_64"),
        ] {
            assert_eq!(decide(root, &step, os, arch), Decision::NotApplicable);
        }
        let inspect = setup_step(root, &["--inspect"]);
        assert_eq!(
            decide(root, &inspect, "macos", "aarch64"),
            Decision::NotApplicable
        );
        let other = Step {
            program: "python".into(),
            args: vec!["tools/iq_pack.py".into()],
            cwd: root.to_owned(),
            env: BTreeMap::new(),
        };
        assert_eq!(
            decide(root, &other, "macos", "aarch64"),
            Decision::NotApplicable
        );
        let mut steps = vec![setup_step(root, &["--family", "qwen"])];
        assert_eq!(prepare_steps(root, &mut steps, "windows", "x86_64"), 0);
        assert_eq!(steps.len(), 1);
        assert!(steps[0].env.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_mac_with_the_verified_engine_runs_setup_in_control_mode_and_never_compiles() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        mac_runtime(root);
        for extra in [
            &["--family", "qwen", "--model", "Q2_0"][..],
            &["--family", "qwen", "--model", "IQ3_XXS", "--vision", "yes"][..],
            &["--family", "gyro", "--model", "Gyro-S"][..],
            &[][..],
        ] {
            let mut step = setup_step(root, extra);
            // Options the app sets for a setup (and the DeepSeek engine path) are kept as they are.
            step.env
                .insert("STRATA_DSV41_EXE".into(), Some("/x/engine-dsv41".into()));
            step.env.insert("STRATA_CONTROL_INSTALL".into(), None);
            let mut steps = vec![step];
            assert_eq!(prepare_steps(root, &mut steps, "macos", "aarch64"), 1);
            // No compiler check in front: nothing is compiled.
            assert_eq!(steps.len(), 1);
            let env = &steps[0].env;
            assert_eq!(env["STRATA_DSV41_EXE"].as_deref(), Some("/x/engine-dsv41"));
            // A value the caller already chose is not overridden.
            assert_eq!(env["STRATA_CONTROL_INSTALL"], None);
            assert_eq!(
                env["STRATA_INSTALL_DIR"].as_deref(),
                Some(root.to_string_lossy().as_ref())
            );
            assert_eq!(
                env["STRATA_COMPONENTS_DIR"].as_deref(),
                Some(root.join("components").to_string_lossy().as_ref())
            );
        }
        let mut steps = vec![setup_step(root, &["--family", "qwen", "--model", "Q2_0"])];
        prepare_steps(root, &mut steps, "macos", "aarch64");
        assert_eq!(steps[0].env["STRATA_CONTROL_INSTALL"].as_deref(), Some("1"));
        // Upstream's component scan finds the engine through the managed view.
        let view = root.join("components/engine");
        let linked: Vec<_> = fs::read_dir(&view).unwrap().flatten().collect();
        assert_eq!(linked.len(), 1);
        assert!(linked[0].path().join("engine-component.json").is_file());
        // A half-failed build folder from an earlier attempt does not matter in Control mode.
        write(&root.join("build-metal/CMakeCache.txt"), "partial");
        let mut again = vec![setup_step(root, &["--family", "qwen", "--model", "Q2_0"])];
        assert_eq!(prepare_steps(root, &mut again, "macos", "aarch64"), 1);
        assert_eq!(again.len(), 1);
    }

    #[test]
    fn a_family_the_mac_installer_lacks_is_refused_before_any_compile() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        mac_runtime(root);
        // Not readable yet: nothing is decided.
        assert_eq!(
            unsupported_family_on_mac(root, "deepseek41", "macos", "aarch64"),
            None
        );
        write(
            &root.join("metal/setup_mac.py"),
            "import argparse\r\n    ap.add_argument(\"--family\", choices=[\"qwen\", \"unsloth\", 'gyro'], default=None,\r\n",
        );
        let refusal = unsupported_family_on_mac(root, "deepseek41", "macos", "aarch64").unwrap();
        assert!(refusal.starts_with("DeepSeek-V4.1-Flash 暂不支持 Mac"));
        assert!(refusal.contains("qwen、unsloth、gyro"));
        for family in ["qwen", "unsloth", "gyro"] {
            assert_eq!(
                unsupported_family_on_mac(root, family, "macos", "aarch64"),
                None
            );
        }
        assert!(unsupported_family_on_mac(root, "qwen36", "macos", "aarch64").is_some());
        // Other hosts are never refused here.
        for (os, arch) in [
            ("linux", "x86_64"),
            ("windows", "x86_64"),
            ("macos", "x86_64"),
        ] {
            assert_eq!(
                unsupported_family_on_mac(root, "deepseek41", os, arch),
                None
            );
        }
        // Control mode serves qwen and gyro even if a future installer drops them.
        write(
            &root.join("metal/setup_mac.py"),
            "ap.add_argument(\"--family\", choices=[\"unsloth\"])\n",
        );
        assert_eq!(
            unsupported_family_on_mac(root, "qwen", "macos", "aarch64"),
            None
        );
        // An unparseable line decides nothing.
        write(
            &root.join("metal/setup_mac.py"),
            "ap.add_argument(\"--family\")\n",
        );
        assert_eq!(
            unsupported_family_on_mac(root, "deepseek41", "macos", "aarch64"),
            None
        );
    }

    #[test]
    fn the_families_control_mode_does_not_serve_keep_the_source_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        mac_runtime(root);
        for extra in [
            &["--family", "unsloth", "--model", "UD-Q4_K_XL"][..],
            &["--family", "deepseek41", "--model", "Q4"][..],
            &["--family", "qwen", "--model", "UD-Q5_K_XL"][..],
        ] {
            assert!(matches!(
                decide(root, &setup_step(root, extra), "macos", "aarch64"),
                Decision::Compile(_)
            ));
        }
    }

    #[test]
    fn an_old_source_or_a_missing_engine_keeps_the_source_build() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        mac_runtime(root);
        let step = setup_step(root, &["--family", "qwen", "--model", "Q2_0"]);
        write(&root.join("setup.py"), "no control mode here\n");
        assert!(matches!(
            decide(root, &step, "macos", "aarch64"),
            Decision::Compile(_)
        ));
        mac_runtime(root);
        fs::remove_file(root.join("engine/.strata-manager-metal.json")).unwrap();
        assert!(matches!(
            decide(root, &step, "macos", "aarch64"),
            Decision::Compile(_)
        ));
        // An engine from an older Manager pin is replaced first; until then it is not trusted either.
        write(
            &root.join("engine/.strata-manager-metal.json"),
            r#"{"version":"0.1.45.3"}"#,
        );
        assert!(matches!(
            decide(root, &step, "macos", "aarch64"),
            Decision::Compile(_)
        ));
    }

    #[test]
    fn preflight_is_added_only_when_a_plain_setup_really_builds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("setup.py"), "no control mode here\n");
        let mut steps = vec![setup_step(
            root,
            &["--family", "unsloth", "--model", "UD-Q4_K_XL"],
        )];
        assert_eq!(prepare_steps(root, &mut steps, "macos", "aarch64"), 0);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].program, "/bin/sh");
        assert!(steps[0].args[1].contains("xcrun --find clang"));
        assert!(steps[0].args[1].contains("clang --version"));
        assert!(steps[0].args[1].contains("xcode-select --install"));
        // A finished earlier build is reused by setup.py: no compiler is needed, so none is checked.
        write(&root.join("build-metal/strata"), "built");
        write(&root.join("build-metal/BUILD.json"), "{}");
        let mut steps = vec![setup_step(
            root,
            &["--family", "unsloth", "--model", "UD-Q4_K_XL"],
        )];
        prepare_steps(root, &mut steps, "macos", "aarch64");
        assert_eq!(steps.len(), 1);
        // A half-failed build folder (no binary) is resumed by setup.py, and still gets the check.
        fs::remove_file(root.join("build-metal/strata")).unwrap();
        let mut steps = vec![setup_step(
            root,
            &["--family", "unsloth", "--model", "UD-Q4_K_XL"],
        )];
        prepare_steps(root, &mut steps, "macos", "aarch64");
        assert_eq!(steps.len(), 2);
    }

    #[test]
    fn a_failed_build_shows_the_last_30_lines_and_the_matching_hint() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let log: String = (1..=50).map(|n| format!("build line {n}\n")).collect::<String>()
            + "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n";
        write(&root.join("build-metal/build.log"), &log);
        let path = root.join("build-metal/build.log");
        let task = vec![
            "  Building the Metal engine from source (5-15 minutes the first time) ...".to_owned(),
            format!(
                "  [X]  the Metal engine did not build (see {})",
                path.display()
            ),
        ];
        let note = compile_failure_note(root, &task).unwrap();
        assert!(note.contains("build line 22"), "{note}");
        assert!(!note.contains("build line 21\n"), "{note}");
        assert!(note.contains("invalid active developer path"));
        assert!(note.contains("xcode-select --install"));
        assert!(note.contains("最后 30 行"));
        // Not a build failure: nothing is added.
        let network = vec!["  [X]  cannot reach huggingface.co".to_owned()];
        assert_eq!(compile_failure_note(root, &network), None);
        // The preflight's own failure already carries its hint.
        let preflight =
            vec!["[X]  这台 Mac 上没有可用的 C/C++ 编译器；xcode-select --install".to_owned()];
        assert_eq!(compile_failure_note(root, &preflight), None);
    }

    #[test]
    fn keyword_hints_cover_the_reported_failures() {
        assert!(!compiler_hints("xcrun: error: invalid active developer path").is_empty());
        assert!(
            compiler_hints("The C compiler identification is unknown")[0].contains("命令行工具")
        );
        assert!(compiler_hints("error: missing Metal Toolchain")[0].contains("MetalToolchain"));
        assert!(
            compiler_hints("fatal error: 'metal-cpp_26/Foundation/Foundation.hpp'")[0]
                .contains("metal-cpp")
        );
        assert!(compiler_hints("xcrun: error: unable to find utility")[0].contains("xcrun"));
        assert!(compiler_hints("all fine").is_empty());
        // The more specific path message is not repeated by the generic xcrun one.
        assert_eq!(
            compiler_hints("xcrun: error: invalid active developer path").len(),
            1
        );
    }

    #[test]
    fn a_log_outside_the_runtime_folder_is_never_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir_all(&root).unwrap();
        let outside = temp.path().join("secret.log");
        fs::write(&outside, "do not read me\n").unwrap();
        let task = vec![format!(
            "  [X]  the Metal engine did not build (see {})",
            outside.display()
        )];
        assert_eq!(compile_failure_note(&root, &task), None);
    }
    /// The wiring that no unit test can run on every host: read the sources (CRLF-normalised).
    fn source(text: &str) -> String {
        text.replace("\r\n", "\n")
    }

    #[test]
    fn the_callers_keep_the_mac_install_wired_to_control_mode() {
        let processes = source(include_str!("processes.rs"));
        assert!(processes.contains("crate::mac_control::prepare_steps("));
        assert!(processes.contains("compile_failure_note("));
        let lib = source(include_str!("lib.rs"));
        assert!(lib.contains("component_engine::ensure_managed_view("));
        assert!(lib.contains("\"STRATA_COMPONENTS_DIR\""));
        let me = source(include_str!("mac_control.rs"));
        assert!(me.contains("\"STRATA_CONTROL_INSTALL\""));
        assert!(me.contains("\"STRATA_INSTALL_DIR\""));
    }
}
