//! Whether an installed engine package includes a picture reader (`strata-vision`).
//! Official SYCL packages (upstream #5716) currently ship without one; that is not
//! a reason to reject the package.

use std::path::{Path, PathBuf};

/// Picture-reader file names official engine packages may ship.
pub const VISION_READER_NAMES: &[&str] = &[
    "strata-vision",
    "strata-vision.exe",
    "strata-vision-hip",
    "strata-vision-hip.exe",
];

/// Whether `name` (a path or a basename) is an official picture-reader binary.
pub fn is_vision_reader_name(name: &str) -> bool {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .to_ascii_lowercase();
    VISION_READER_NAMES.iter().any(|wanted| base == *wanted)
}

/// The picture reader directly inside `dir`, if that directory holds one.
pub fn vision_reader_in_dir(dir: &Path) -> Option<PathBuf> {
    for name in VISION_READER_NAMES {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    // Case-insensitive fallback (Windows packages on a case-sensitive disk).
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if entry
            .file_name()
            .to_str()
            .is_some_and(is_vision_reader_name)
        {
            return Some(path);
        }
    }
    None
}

/// Engine package directories to inspect, including component packages under
/// `<root>/components/engine/*`. The DeepSeek engine folder is never included.
fn package_dirs(root: &Path, exe: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = crate::discovery::engine_package_dirs(root, exe);
    let components = root.join("components").join("engine");
    if let Ok(entries) = std::fs::read_dir(&components) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            }
        }
    }
    let mut unique = Vec::new();
    for dir in dirs {
        if unique.iter().any(|existing: &PathBuf| existing == &dir) {
            continue;
        }
        unique.push(dir);
    }
    unique
}

/// Path of a picture reader in the runtime's engine package, if one is present.
pub fn engine_vision_reader(root: &Path, exe: Option<&Path>) -> Option<PathBuf> {
    package_dirs(root, exe)
        .into_iter()
        .find_map(|dir| vision_reader_in_dir(&dir))
}

/// Whether the installed engine package includes a picture reader.
pub fn engine_has_vision_reader(root: &Path, exe: Option<&Path>) -> bool {
    engine_vision_reader(root, exe).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reader_names_are_recognized_and_other_engine_files_are_not() {
        for name in [
            "strata-vision",
            "strata-vision.exe",
            "STRATA-VISION.EXE",
            r"D:\Strata\engine\strata-vision-hip.exe",
            "/opt/strata/engine/strata-vision-hip",
        ] {
            assert!(is_vision_reader_name(name), "{name}");
        }
        for name in [
            "strata",
            "strata.exe",
            "strata-sycl.sh",
            "BUILD.json",
            "engine",
        ] {
            assert!(!is_vision_reader_name(name), "{name}");
        }
    }

    #[test]
    fn a_sycl_style_engine_folder_without_a_reader_is_text_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let engine = root.join("engine-sycl");
        fs::create_dir_all(&engine).unwrap();
        fs::write(engine.join("BUILD.json"), br#"{"version":"0.1.59"}"#).unwrap();
        fs::write(engine.join("strata"), b"sycl").unwrap();
        assert!(vision_reader_in_dir(&engine).is_none());
        assert!(!engine_has_vision_reader(root, None));
        assert!(engine_vision_reader(root, None).is_none());
    }

    #[test]
    fn a_package_with_strata_vision_is_detected_and_dsv41_is_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let engine = root.join("engine");
        fs::create_dir_all(&engine).unwrap();
        fs::write(
            engine.join("BUILD.json"),
            br#"{"version":"0.1.59","vision":"cuda"}"#,
        )
        .unwrap();
        fs::write(engine.join("strata"), b"cuda").unwrap();
        fs::write(engine.join("strata-vision"), b"reader").unwrap();
        let dsv41 = root.join("engine-dsv41");
        fs::create_dir_all(&dsv41).unwrap();
        // A DeepSeek-only reader must not count as the main engine package's reader
        // when the main package itself has none; here the main package does have one.
        fs::write(dsv41.join("strata-vision"), b"other").unwrap();
        let found = engine_vision_reader(root, Some(&engine.join("strata"))).unwrap();
        assert_eq!(found, engine.join("strata-vision"));
        assert!(engine_has_vision_reader(root, Some(&engine.join("strata"))));
    }

    #[test]
    fn a_dsv41_reader_alone_does_not_count_for_the_main_engine_package() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let sycl = root.join("engine-sycl");
        fs::create_dir_all(&sycl).unwrap();
        fs::write(sycl.join("BUILD.json"), br#"{"version":"0.1.59"}"#).unwrap();
        fs::write(sycl.join("strata"), b"sycl").unwrap();
        let dsv41 = root.join("engine-dsv41");
        fs::create_dir_all(&dsv41).unwrap();
        fs::write(dsv41.join("strata-vision"), b"other").unwrap();
        assert!(!engine_has_vision_reader(root, None));
    }

    #[test]
    fn hip_and_exe_reader_names_and_a_component_package_are_found() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let pkg = root
            .join("components")
            .join("engine")
            .join("0.1.59-windows-x86_64-hip-rx9070");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(pkg.join("BUILD.json"), br#"{"version":"0.1.59"}"#).unwrap();
        fs::write(pkg.join("strata.exe"), b"MZ").unwrap();
        fs::write(pkg.join("strata-vision-hip.exe"), b"MZ").unwrap();
        let found = engine_vision_reader(root, None).unwrap();
        assert_eq!(found, pkg.join("strata-vision-hip.exe"));
    }
}
