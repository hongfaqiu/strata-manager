//! A control vector GGUF chosen for `--control-vector-scaled` (Strata engine 0.1.44+, llama.cpp's format):
//! read-only header check so the launch form can say whether the file exists and is a control vector before
//! the engine refuses it at start (generate.cpp `load_control_vectors`: "general.architecture is not
//! 'controlvector'"). The upstream release ships one under
//! `data/experimental-speed-projection/` (setup.py `ESP_VECTOR`); nothing is downloaded or written here.
use std::path::Path;

use serde::Serialize;

use crate::gguf_check::{self, ShardCheck};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlVectorCheck {
    pub path: String,
    /// ok | missing | unreadable | notGguf | notControlVector | short | empty
    pub status: &'static str,
    pub bytes: Option<u64>,
    pub architecture: Option<String>,
    /// `direction.<layer>` tensors in the file and the highest layer number among them.
    pub layers: u64,
    pub max_layer: Option<u64>,
    pub detail: Option<String>,
}

pub fn inspect(path: &str) -> ControlVectorCheck {
    let trimmed = path.trim();
    let mut out = ControlVectorCheck {
        path: trimmed.to_string(),
        status: "ok",
        bytes: None,
        architecture: None,
        layers: 0,
        max_layer: None,
        detail: None,
    };
    let p = Path::new(trimmed);
    if trimmed.is_empty() || !p.exists() {
        out.status = "missing";
        return out;
    }
    if !p.is_file() {
        out.status = "unreadable";
        out.detail = Some("not a file".into());
        return out;
    }
    match gguf_check::check(p) {
        ShardCheck::Whole(header) => {
            out.bytes = Some(header.file_bytes);
            out.layers = header.direction_tensors;
            out.max_layer = header.direction_max_layer;
            out.architecture = header.architecture.clone();
            out.status = if header.architecture.as_deref() != Some("controlvector") {
                "notControlVector"
            } else if header.direction_tensors == 0 {
                "empty"
            } else {
                "ok"
            };
        }
        ShardCheck::Short { have, .. } => {
            out.bytes = Some(have);
            out.status = "short";
        }
        ShardCheck::NotGguf => out.status = "notGguf",
        ShardCheck::Unreadable(error) => {
            out.status = "unreadable";
            out.detail = Some(error);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn string(out: &mut Vec<u8>, s: &str) {
        out.extend((s.len() as u64).to_le_bytes());
        out.extend(s.as_bytes());
    }

    /// A llama.cpp-style control vector: `general.architecture = controlvector`, one f32 `direction.<l>` per layer.
    fn vector(path: &Path, architecture: &str, layers: &[u64], n_embd: u64) {
        let mut out = Vec::new();
        out.extend(b"GGUF");
        out.extend(3_u32.to_le_bytes());
        out.extend((layers.len() as u64).to_le_bytes());
        out.extend(2_u64.to_le_bytes());
        string(&mut out, "general.architecture");
        out.extend(8_u32.to_le_bytes());
        string(&mut out, architecture);
        string(&mut out, "controlvector.layer_count");
        out.extend(4_u32.to_le_bytes());
        out.extend((layers.len() as u32).to_le_bytes());
        for (i, layer) in layers.iter().enumerate() {
            string(&mut out, &format!("direction.{layer}"));
            out.extend(1_u32.to_le_bytes());
            out.extend(n_embd.to_le_bytes());
            out.extend(0_u32.to_le_bytes());
            out.extend((i as u64 * n_embd * 4).to_le_bytes());
        }
        let start = (out.len() as u64).div_ceil(32) * 32;
        out.resize(start as usize, 0);
        out.resize((start + layers.len() as u64 * n_embd * 4) as usize, 0);
        fs::write(path, out).unwrap();
    }

    #[test]
    fn a_control_vector_reports_its_layers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.gguf");
        vector(&path, "controlvector", &(1..=47).collect::<Vec<_>>(), 16);
        let check = inspect(path.to_str().unwrap());
        assert_eq!(check.status, "ok", "{check:?}");
        assert_eq!((check.layers, check.max_layer), (47, Some(47)));
        assert_eq!(check.architecture.as_deref(), Some("controlvector"));
    }

    #[test]
    fn model_weights_and_other_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("m.gguf");
        vector(&model, "qwen3next", &[1], 16);
        assert_eq!(inspect(model.to_str().unwrap()).status, "notControlVector");
        let text = dir.path().join("x.gguf");
        fs::write(&text, b"not a gguf at all, just text").unwrap();
        assert_eq!(inspect(text.to_str().unwrap()).status, "notGguf");
        assert_eq!(
            inspect(dir.path().join("none.gguf").to_str().unwrap()).status,
            "missing"
        );
        assert_eq!(inspect("  ").status, "missing");
        let cut = dir.path().join("cut.gguf");
        vector(&cut, "controlvector", &[1, 2], 64);
        let len = fs::metadata(&cut).unwrap().len();
        fs::File::options()
            .write(true)
            .open(&cut)
            .unwrap()
            .set_len(len - 100)
            .unwrap();
        assert_eq!(inspect(cut.to_str().unwrap()).status, "short");
    }

    #[test]
    fn a_vector_without_directions_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e.gguf");
        vector(&path, "controlvector", &[], 16);
        assert_eq!(inspect(path.to_str().unwrap()).status, "empty");
    }

    /// The upstream package, when a checkout is next to this repository (skipped otherwise).
    #[test]
    fn the_upstream_bundled_vector_when_present() {
        let path = Path::new("/workspace/strata-upstream/data/experimental-speed-projection/Qwen3.8-Flash-Next-experimental-speed-projection.gguf");
        if !path.is_file() {
            return;
        }
        let check = inspect(path.to_str().unwrap());
        assert_eq!(check.status, "ok", "{check:?}");
        assert_eq!((check.layers, check.max_layer), (47, Some(47)));
    }
}
