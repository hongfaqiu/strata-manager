//! Install the application-owned Python bootstrap without changing a Strata checkout.
use std::{
    fs,
    path::{Path, PathBuf},
};

const OBSERVER: &str = include_str!("../../../apps/supervisor/resources/strata_observer.py");
const MCP_GUARD: &str = include_str!("../../../apps/supervisor/resources/strata_mcp_guard.py");
const BOOTSTRAP: &str = "import strata_observer\nstrata_observer.install()\nimport strata_mcp_guard\nstrata_mcp_guard.install()\n";

pub fn install_bootstrap(data_dir: &Path) -> Result<PathBuf, String> {
    let directory = data_dir.join("observer-v1");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    for (name, content) in [
        ("strata_observer.py", OBSERVER),
        ("strata_mcp_guard.py", MCP_GUARD),
        ("sitecustomize.py", BOOTSTRAP),
    ] {
        let target = directory.join(name);
        if fs::read_to_string(&target).ok().as_deref() != Some(content) {
            // Atomic replacement also keeps an older running Python process intact.
            let temp = directory.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
            fs::write(&temp, content).map_err(|e| e.to_string())?;
            if let Err(e) = fs::rename(&temp, &target) {
                // Windows cannot replace an existing destination with rename.
                // The file isn't an executable and already imported code remains
                // resident; use a versioned directory on observer format upgrades.
                if target.exists() {
                    fs::remove_file(&target).map_err(|e| e.to_string())?;
                    fs::rename(&temp, &target).map_err(|e| e.to_string())?;
                } else {
                    return Err(e.to_string());
                }
            }
        }
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_is_idempotent_and_only_app_owned() {
        let temp = tempfile::tempdir().unwrap();
        let first = install_bootstrap(temp.path()).unwrap();
        let second = install_bootstrap(temp.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            fs::read_to_string(first.join("sitecustomize.py")).unwrap(),
            BOOTSTRAP
        );
        assert!(fs::read_to_string(first.join("strata_observer.py"))
            .unwrap()
            .contains("SUPPORTED_HASHES"));
    }
}
