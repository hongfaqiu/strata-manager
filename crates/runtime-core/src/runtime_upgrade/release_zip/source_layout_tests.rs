//! Official source ZIPs before and after upstream's 0.2.16 layout move (#243): detection,
//! the entry → install path mapping, and extraction, from the real archives' path lists.
use super::*;
use std::{collections::HashMap, io::Cursor};

const V0215: &str = include_str!("../fixtures/source-v0.2.15-paths.txt");
const V0222: &str = include_str!("../fixtures/source-v0.2.22-paths.txt");

fn paths(list: &str) -> Vec<&str> {
    list.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

/// A source ZIP with one top folder holding `paths`, each with a small body.
fn source_zip(dir: &Path, top: &str, paths: &[&str]) -> PathBuf {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for path in paths {
        writer
            .start_file(
                format!("{top}/{path}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(format!("# {path}\n").as_bytes()).unwrap();
    }
    let archive = dir.join(format!("{top}.zip"));
    fs::write(&archive, writer.finish().unwrap().into_inner()).unwrap();
    archive
}

#[test]
fn layouts_are_detected_from_the_real_archives() {
    assert_eq!(detect_source_layout(paths(V0215)), SourceLayout::Flat);
    assert_eq!(detect_source_layout(paths(V0222)), SourceLayout::Split);
    // Not enough to call a tree split: every marker is needed, and a root setup.py wins.
    for names in [
        vec!["terminal/setup.py", "terminal/serve/server.py"],
        vec!["terminal/setup.py", "engine/CMakeLists.txt"],
        vec![
            "setup.py",
            "terminal/setup.py",
            "terminal/serve/server.py",
            "engine/CMakeLists.txt",
        ],
    ] {
        assert_eq!(detect_source_layout(names), SourceLayout::Flat);
    }
}

#[test]
fn flat_layout_keeps_the_historic_allow_list() {
    for path in paths(V0215) {
        assert_eq!(
            source_target(SourceLayout::Flat, path),
            source_file(path).then(|| path.to_owned()),
            "{path}"
        );
    }
}

#[test]
fn split_layout_maps_terminal_and_engine_onto_the_flat_install() {
    let mapped: HashMap<&str, Option<String>> = paths(V0222)
        .into_iter()
        .map(|path| (path, source_target(SourceLayout::Split, path)))
        .collect();
    for (from, to) in [
        ("terminal/setup.py", "setup.py"),
        ("terminal/serve/server.py", "serve/server.py"),
        ("terminal/serve/runconfig.py", "serve/runconfig.py"),
        ("terminal/serve/web/index.html", "serve/web/index.html"),
        ("terminal/requirements.txt", "requirements.txt"),
        ("terminal/strata.py", "strata.py"),
        (
            "terminal/strata_control/__init__.py",
            "strata_control/__init__.py",
        ),
        ("terminal/strata_cli/__init__.py", "strata_cli/__init__.py"),
        ("terminal/tools/strata_mcp.py", "tools/strata_mcp.py"),
        ("engine/CMakeLists.txt", "CMakeLists.txt"),
        (
            "engine/third_party/ggml/ggml-common-tq.h",
            "third_party/ggml/ggml-common-tq.h",
        ),
        ("START-HERE.bat", "START-HERE.bat"),
        ("setup.sh", "setup.sh"),
        ("LICENSE", "LICENSE"),
        ("README.md", "README.md"),
    ] {
        assert_eq!(mapped.get(from), Some(&Some(to.to_owned())), "{from}");
    }
    // The repository's own checks and packaging, the desktop app, CI, Python tests and
    // engine parts the flat tree never installed stay out.
    for path in [
        "AGENTS.md",
        "terminal/requirements-dev.txt",
        "engine/CMakePresets.json",
        "engine/metal/CMakeLists.txt",
        "engine/third_party/strata-gguf-py/pyproject.toml",
    ] {
        assert_eq!(mapped.get(path), Some(&None), "{path}");
    }
    for (path, target) in &mapped {
        let top = path.split('/').next().unwrap();
        if matches!(top, "tools" | "app" | ".github") || path.starts_with("terminal/tests/") {
            assert_eq!(target, &None, "{path}");
        }
        // Every target is a path the flat tree also installs: one install shape for both.
        if let Some(target) = target {
            assert!(source_file(target), "{path} -> {target}");
            assert!(!target.starts_with("terminal/") && !target.starts_with("engine/"));
        }
    }
}

#[test]
fn both_layouts_extract_to_the_same_runtime_shape() {
    let temp = tempfile::tempdir().unwrap();
    for (top, list) in [("Strata-0.2.15", V0215), ("Strata-0.2.22", V0222)] {
        let archive = source_zip(temp.path(), top, &paths(list));
        let destination = temp.path().join(format!("{top}-out"));
        let files = extract(&archive, &destination, true, || Ok(())).unwrap();
        for required in [
            "setup.py",
            "serve/server.py",
            "requirements.txt",
            "CMakeLists.txt",
            "strata_control/__init__.py",
            "tools/strata_mcp.py",
        ] {
            assert!(destination.join(required).is_file(), "{top}: {required}");
            assert!(files.iter().any(|f| f == required), "{top}: {required}");
        }
        assert!(!destination.join("terminal").exists(), "{top}");
        assert!(!destination.join("engine").exists(), "{top}");
        assert!(!destination.join("app").exists(), "{top}");
        // The split tree's root tools/ (packaging) never reaches the install's tools/.
        assert!(!destination.join("tools/packaging").exists(), "{top}");
        assert_eq!(
            fs::read_to_string(destination.join("serve/server.py")).unwrap(),
            if top.ends_with("15") {
                "# serve/server.py\n"
            } else {
                "# terminal/serve/server.py\n"
            }
        );
    }
}

#[test]
fn split_archive_missing_a_required_file_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let without_engine: Vec<&str> = paths(V0222)
        .into_iter()
        .filter(|path| *path != "engine/CMakeLists.txt")
        .collect();
    let without_requirements: Vec<&str> = paths(V0222)
        .into_iter()
        .filter(|path| *path != "terminal/requirements.txt")
        .collect();
    for (name, list) in [
        ("no-engine", without_engine),
        ("no-requirements", without_requirements),
    ] {
        let archive = source_zip(temp.path(), name, &list);
        let error = extract(&archive, &temp.path().join(name), true, || Ok(())).unwrap_err();
        assert!(error.contains("官方ZIP缺少必要程序文件"), "{name}: {error}");
    }
}

/// The real official ZIPs: `STRATA_MANAGER_SOURCE_ZIPS=/path/v0.2.15.zip:/path/v0.2.22.zip`.
#[test]
#[ignore = "requires separately downloaded official source ZIPs"]
fn official_source_zips_of_both_layouts_from_environment() {
    let list = std::env::var("STRATA_MANAGER_SOURCE_ZIPS")
        .expect("set STRATA_MANAGER_SOURCE_ZIPS to ':'-separated official source ZIPs");
    for archive in list.split(':').filter(|s| !s.is_empty()).map(PathBuf::from) {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("source");
        let files = extract(&archive, &destination, true, || Ok(())).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&archive).unwrap()).unwrap();
        let leaves: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index_raw(i).unwrap().name().to_owned())
            .filter_map(|name| name.split_once('/').map(|(_, leaf)| leaf.to_owned()))
            .collect();
        let layout = detect_source_layout(leaves.iter().map(String::as_str));
        let mut expected = 0;
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).unwrap();
            if entry.is_dir() {
                continue;
            }
            let relative = entry.name().split_once('/').unwrap().1.to_owned();
            let Some(target) = source_target(layout, &relative) else {
                continue;
            };
            expected += 1;
            let mut original = Vec::new();
            entry.read_to_end(&mut original).unwrap();
            assert_eq!(fs::read(destination.join(&target)).unwrap(), original);
        }
        assert_eq!(expected, files.len());
        for relative in ["serve/web/index.html", "strata_control/__init__.py"] {
            assert!(destination.join(relative).is_file(), "{relative}");
        }
        let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
        command
            .args(["-I", "-S", "-c", PYTHON_PROBE])
            .arg(&destination)
            .arg("syntax-only");
        processes::hidden(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        println!(
            "{}: {layout:?}, {} runtime files",
            archive.display(),
            files.len()
        );
    }
}
