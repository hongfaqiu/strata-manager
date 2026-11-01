//! Upstream setup.py writes absolute paths into the component folder that was in use when a
//! model was set up: `cwd`, engine arguments such as `--expert-profile`, and the vision
//! reader paths. `strata update` keeps only the two newest control and engine folders, so an
//! older run config points into a folder that is gone (upstream #4891/#4899: Windows launch
//! dies with WinError 267, doctor reports the model as not installed).
//!
//! The same file of the newest sibling component folder that really has it stands in for a
//! gone path, the way upstream `with_current_control_paths()` answers it at load time. A path
//! that still exists, or one outside `<components>/control|engine/<folder>`, is left alone.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SIBLINGS: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Control,
    Engine,
}

/// The component folder (`<components>/control|engine/<folder>`) a path lives in.
fn component_folder(path: &Path) -> Option<(PathBuf, Kind)> {
    for ancestor in path.ancestors() {
        let (Some(parent), Some(grand)) =
            (ancestor.parent(), ancestor.parent().and_then(Path::parent))
        else {
            continue;
        };
        let named = |p: &Path, want: &str| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(want))
        };
        if !named(grand, "components") || ancestor.file_name().is_none() {
            continue;
        }
        if named(parent, "control") {
            return Some((ancestor.to_owned(), Kind::Control));
        }
        if named(parent, "engine") {
            return Some((ancestor.to_owned(), Kind::Engine));
        }
    }
    None
}

/// `0.1.55` or `0.1.55-windows-x64-cuda` → ([0,1,55], "windows-x64-cuda").
fn folder_version(name: &str) -> (Vec<u32>, String) {
    let name = name.trim_start_matches('v');
    let (core, rest) = name.split_once('-').unwrap_or((name, ""));
    let numbers = core
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect();
    (numbers, rest.to_ascii_lowercase())
}

fn is_control_root(path: &Path) -> bool {
    path.join("setup.py").is_file() && path.join("serve").join("server.py").is_file()
}

/// The same path in the newest sibling component folder that has it, when `path` is gone.
pub(crate) fn current_component_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.exists() {
        return None;
    }
    let (old, kind) = component_folder(path)?;
    let relative = path.strip_prefix(&old).ok()?;
    let parent = old.parent()?;
    let old_name = old.file_name()?.to_string_lossy().into_owned();
    let (_, old_flavor) = folder_version(&old_name);
    let mut siblings: Vec<(Vec<u32>, String, PathBuf)> = fs::read_dir(parent)
        .ok()?
        .take(MAX_SIBLINGS)
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == old_name || name.starts_with('.') || path.is_symlink() || !path.is_dir() {
                return None;
            }
            let (version, flavor) = folder_version(&name);
            // An engine package for another backend (cuda vs vulkan) is not the same engine.
            if kind == Kind::Engine && flavor != old_flavor {
                return None;
            }
            Some((version, name, path))
        })
        .collect();
    siblings.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    siblings.into_iter().find_map(|(_, _, folder)| {
        let candidate = if relative.as_os_str().is_empty() {
            folder
        } else {
            folder.join(relative)
        };
        let usable = if relative.as_os_str().is_empty() && kind == Kind::Control {
            is_control_root(&candidate)
        } else {
            candidate.exists()
        };
        usable.then_some(candidate)
    })
}

fn rebase_str(value: &str, changes: &mut Vec<(String, String)>) -> Option<String> {
    let moved = current_component_path(Path::new(value))?;
    let moved = moved.to_string_lossy().into_owned();
    changes.push((value.to_owned(), moved.clone()));
    Some(moved)
}

/// A copy of the run config whose gone component paths follow the newest component folder,
/// with the (old, new) pairs it changed; None when nothing needs to change.
pub(crate) fn rebase_config(config: &Value) -> Option<(Value, Vec<(String, String)>)> {
    let mut fixed = config.clone();
    let mut changes = Vec::new();
    if let Some(moved) = config
        .get("cwd")
        .and_then(Value::as_str)
        .and_then(|cwd| rebase_str(cwd, &mut changes))
    {
        fixed["cwd"] = Value::String(moved);
    }
    if let Some(args) = fixed.get_mut("args").and_then(Value::as_array_mut) {
        for item in args.iter_mut() {
            if let Some(moved) = item.as_str().and_then(|v| rebase_str(v, &mut changes)) {
                *item = Value::String(moved);
            }
        }
    }
    if let Some(vision) = fixed.get_mut("vision").and_then(Value::as_object_mut) {
        for key in ["exe", "model", "mmproj"] {
            if let Some(moved) = vision
                .get(key)
                .and_then(Value::as_str)
                .and_then(|v| rebase_str(v, &mut changes))
            {
                vision.insert(key.into(), Value::String(moved));
            }
        }
    }
    (!changes.is_empty()).then_some((fixed, changes))
}

/// The install root a gone `components/control/<version>` folder now lives at.
pub(crate) fn current_control_root(root: &Path) -> Option<PathBuf> {
    match component_folder(root) {
        Some((folder, Kind::Control)) if folder == root => current_component_path(root),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn control(components: &Path, version: &str) -> PathBuf {
        let root = components.join("control").join(version);
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("setup.py"), b"").unwrap();
        fs::write(root.join("serve/server.py"), b"").unwrap();
        fs::write(root.join("data/expert-profile.bin"), b"p").unwrap();
        root
    }

    #[test]
    fn gone_control_paths_follow_the_newest_control_that_has_them() {
        let temp = tempfile::tempdir().unwrap();
        let components = temp.path().join("Strata").join("components");
        let newer = control(&components, "0.1.55");
        let older = control(&components, "0.1.54");
        // 0.1.56 is newest but lacks the profile: only a folder that really has the file counts.
        let partial = components.join("control/0.1.56");
        fs::create_dir_all(partial.join("serve")).unwrap();
        fs::write(partial.join("setup.py"), b"").unwrap();
        fs::write(partial.join("serve/server.py"), b"").unwrap();
        let gone = components.join("control/0.1.47");
        let vision_old = components.join("engine/0.1.47-windows-x64-cuda/vision.exe");
        let vision_new = components.join("engine/0.1.55-windows-x64-cuda/vision.exe");
        let vision_other = components.join("engine/0.1.57-windows-x64-vulkan/vision.exe");
        for file in [&vision_new, &vision_other] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"").unwrap();
        }
        let model = temp.path().join("models/model.gguf");
        let config = json!({
            "exe": "component:strata-engine",
            "cwd": gone,
            "args": ["--native", model, "--expert-profile", gone.join("data/expert-profile.bin"), "--ctx", "4096"],
            "vision": {"exe": vision_old, "mmproj": temp.path().join("mmproj.gguf")},
        });
        let (fixed, changes) = rebase_config(&config).unwrap();
        assert_eq!(fixed["cwd"], json!(partial));
        assert_eq!(
            fixed["args"][3],
            json!(newer.join("data/expert-profile.bin"))
        );
        assert_eq!(
            fixed["args"][1],
            json!(model),
            "a path outside components is the person's choice"
        );
        assert_eq!(fixed["args"][5], json!("4096"));
        assert_eq!(
            fixed["vision"]["exe"],
            json!(vision_new),
            "same backend only"
        );
        assert_eq!(changes.len(), 3);
        assert!(older.is_dir());
        assert_eq!(current_control_root(&gone), Some(partial.clone()));
    }

    #[test]
    fn existing_or_foreign_paths_are_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        let components = temp.path().join("components");
        let live = control(&components, "0.1.55");
        let config = json!({"exe": "x", "cwd": live, "args": ["--expert-profile", live.join("data/expert-profile.bin")]});
        assert!(rebase_config(&config).is_none());
        // A person's own <data>/control/<x> tree is not a component folder.
        let own = temp
            .path()
            .join("data/control/0.1.47/data/expert-profile.bin");
        fs::create_dir_all(temp.path().join("data/control/0.1.55/data")).unwrap();
        fs::write(
            temp.path()
                .join("data/control/0.1.55/data/expert-profile.bin"),
            b"",
        )
        .unwrap();
        assert_eq!(current_component_path(&own), None);
        // Nothing to move to: the gone path stays as it is.
        let lone = temp.path().join("other/components/control/0.1.47");
        fs::create_dir_all(temp.path().join("other/components/control")).unwrap();
        assert_eq!(current_component_path(&lone), None);
        assert!(rebase_config(&json!({"cwd": lone, "args": []})).is_none());
    }
}
