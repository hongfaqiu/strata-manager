//! Whether a GGUF shard is whole, judged by its own header (upstream setup.py `check_shards` with
//! tools/gguf_reader.py): the tensor directory says how long the file must be, so a truncated copy is found
//! without hashing, and a small shard that is complete is not refused. Unsloth's gguf-split puts only metadata in
//! shard 1 (UD-Q6_K_XL 00001 is 10,946,624 bytes, setup.py's pinned size): a size floor called it incomplete.
//! Only the header is read; tensor data is skipped.
use std::{
    fs,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

/// Header reads stop here: a garbage count cannot make the scan walk a whole disk.
const MAX_HEADER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COUNT: u64 = 16 * 1024 * 1024;
const MAX_DIMS: u32 = 8;

#[derive(Clone, Debug, PartialEq)]
pub enum ShardCheck {
    /// Header parsed and the file is at least as long as its tensor directory needs.
    Whole(GgufHeader),
    /// The file ends before its tensors (or inside its own header).
    Short { have: u64, need: Option<u64> },
    /// Not a GGUF (wrong magic or version).
    NotGguf,
    /// Could not be opened or read.
    Unreadable(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GgufHeader {
    pub version: u32,
    pub tensors: u64,
    /// `split.no` (0-based) and `split.count` when gguf-split wrote them.
    pub split_no: Option<u64>,
    pub split_count: Option<u64>,
    pub file_bytes: u64,
    /// The length the tensor directory needs (`data_start + max(offset + bytes)`).
    pub need_bytes: u64,
    /// `general.architecture` when it is a short string (`controlvector` for a llama.cpp control vector).
    pub architecture: Option<String>,
    /// Tensors named `direction.<layer>` (a control vector's per-layer directions) and the highest layer seen.
    pub direction_tensors: u64,
    pub direction_max_layer: Option<u64>,
}

/// ggml block geometry (elements per block, bytes per block), tools/gguf_reader.py BLOCK_GEOMETRY.
fn geometry(type_id: u32) -> Option<(u64, u64)> {
    Some(match type_id {
        0 => (1, 4),
        1 | 30 => (1, 2),
        28 => (1, 8),
        24 => (1, 1),
        25 => (1, 2),
        26 => (1, 4),
        27 => (1, 8),
        2 => (32, 18),
        3 => (32, 20),
        6 => (32, 22),
        7 => (32, 24),
        8 => (32, 34),
        9 => (32, 36),
        10 => (256, 84),
        11 => (256, 110),
        12 => (256, 144),
        13 => (256, 176),
        14 => (256, 210),
        15 => (256, 292),
        16 => (256, 66),
        17 => (256, 74),
        18 => (256, 98),
        19 => (256, 50),
        20 => (32, 18),
        21 => (256, 110),
        22 => (256, 82),
        23 => (256, 136),
        29 => (256, 56),
        39 => (32, 17),
        40 => (64, 36),
        42 => (64, 18),
        143 => (128, 28),
        144 => (128, 34),
        145 => (128, 26),
        146 => (128, 30),
        _ => return None,
    })
}

struct Reader<R> {
    /// `seek_relative` keeps the buffer: a 150k-token vocabulary is skipped without a syscall per token.
    inner: BufReader<R>,
    pos: u64,
    len: u64,
}

fn eof() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "header ends early")
}

impl<R: Read + Seek> Reader<R> {
    fn bytes<const N: usize>(&mut self) -> io::Result<[u8; N]> {
        let mut b = [0_u8; N];
        self.inner.read_exact(&mut b)?;
        self.pos += N as u64;
        Ok(b)
    }
    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }
    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }
    fn skip(&mut self, n: u64) -> io::Result<()> {
        let end = self.pos.checked_add(n).ok_or_else(eof)?;
        if end > self.len || end > MAX_HEADER_BYTES {
            return Err(eof());
        }
        match i64::try_from(n) {
            Ok(n) => self.inner.seek_relative(n)?,
            Err(_) => {
                self.inner.seek(SeekFrom::Start(end))?;
            }
        }
        self.pos = end;
        Ok(())
    }
    fn string(&mut self) -> io::Result<String> {
        let n = self.u64()?;
        if n > 1024 {
            self.skip(n)?;
            return Ok(String::new());
        }
        let mut b = vec![0_u8; n as usize];
        self.inner.read_exact(&mut b)?;
        self.pos += n;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }
    /// A metadata value: integers are returned, everything else skipped.
    fn value(&mut self, kind: u32) -> io::Result<Option<u64>> {
        Ok(match kind {
            0 => Some(self.bytes::<1>()?[0] as u64),
            1 | 7 => {
                self.skip(1)?;
                None
            }
            2 => Some(u16::from_le_bytes(self.bytes()?) as u64),
            3 => {
                self.skip(2)?;
                None
            }
            4 => Some(self.u32()? as u64),
            5 => Some(i32::from_le_bytes(self.bytes()?).max(0) as u64),
            6 => {
                self.skip(4)?;
                None
            }
            8 => {
                let n = self.u64()?;
                self.skip(n)?;
                None
            }
            9 => {
                let element = self.u32()?;
                let count = self.u64()?;
                if count > MAX_COUNT {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "array too long"));
                }
                let width = match element {
                    0 | 1 | 7 => Some(1),
                    2 | 3 => Some(2),
                    4..=6 => Some(4),
                    10..=12 => Some(8),
                    _ => None,
                };
                match width {
                    Some(w) => self.skip(w * count)?,
                    None if element == 8 => {
                        for _ in 0..count {
                            let n = self.u64()?;
                            self.skip(n)?;
                        }
                    }
                    None => return Err(io::Error::new(io::ErrorKind::InvalidData, "nested array")),
                }
                None
            }
            10 => Some(self.u64()?),
            11 => Some(i64::from_le_bytes(self.bytes()?).max(0) as u64),
            12 => {
                self.skip(8)?;
                None
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unknown metadata type",
                ))
            }
        })
    }
}

/// Reads the header of `path` and compares the file's length with what its tensor directory needs.
pub fn check(path: &Path) -> ShardCheck {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => return ShardCheck::Unreadable(error.to_string()),
    };
    let have = match file.metadata() {
        Ok(meta) => meta.len(),
        Err(error) => return ShardCheck::Unreadable(error.to_string()),
    };
    let mut reader = Reader {
        inner: BufReader::with_capacity(256 * 1024, file),
        pos: 0,
        len: have,
    };
    match parse(&mut reader, have) {
        Ok(Some(header)) if header.file_bytes >= header.need_bytes => ShardCheck::Whole(header),
        Ok(Some(header)) => ShardCheck::Short {
            have,
            need: Some(header.need_bytes),
        },
        Ok(None) => ShardCheck::NotGguf,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            if have < 8 {
                ShardCheck::NotGguf
            } else {
                ShardCheck::Short { have, need: None }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::InvalidData => ShardCheck::NotGguf,
        Err(error) => ShardCheck::Unreadable(error.to_string()),
    }
}

fn parse<R: Read + Seek>(r: &mut Reader<R>, have: u64) -> io::Result<Option<GgufHeader>> {
    let magic: [u8; 4] = match r.bytes() {
        Ok(magic) => magic,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    };
    if &magic != b"GGUF" {
        return Ok(None);
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return Ok(None);
    }
    let tensors = r.u64()?;
    let kvs = r.u64()?;
    if tensors > MAX_COUNT || kvs > MAX_COUNT {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad counts"));
    }
    let mut header = GgufHeader {
        version,
        tensors,
        file_bytes: have,
        ..Default::default()
    };
    let mut alignment = 32_u64;
    for _ in 0..kvs {
        let key = r.string()?;
        let kind = r.u32()?;
        if key == "general.architecture" && kind == 8 {
            let text = r.string()?;
            header.architecture = (!text.is_empty()).then_some(text);
            continue;
        }
        let value = r.value(kind)?;
        match key.as_str() {
            "general.alignment" => {
                if let Some(a) = value.filter(|a| *a > 0 && a.is_power_of_two()) {
                    alignment = a;
                }
            }
            "split.no" => header.split_no = value,
            "split.count" => header.split_count = value,
            _ => {}
        }
    }
    let mut end = 0_u64;
    for _ in 0..tensors {
        let n = r.u64()?;
        if n <= 64 {
            let mut name = vec![0_u8; n as usize];
            r.inner.read_exact(&mut name)?;
            r.pos += n;
            if let Some(layer) = std::str::from_utf8(&name)
                .ok()
                .and_then(|name| name.strip_prefix("direction."))
                .and_then(|layer| layer.parse::<u64>().ok())
            {
                header.direction_tensors += 1;
                header.direction_max_layer =
                    Some(header.direction_max_layer.map_or(layer, |m| m.max(layer)));
            }
        } else {
            r.skip(n)?;
        }
        let dims = r.u32()?;
        if dims > MAX_DIMS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "bad tensor dims",
            ));
        }
        let mut elements = 1_u128;
        for _ in 0..dims {
            elements = elements.saturating_mul(r.u64()? as u128);
        }
        let type_id = r.u32()?;
        let offset = r.u64()?;
        // An unknown type contributes its offset only: the check stays a lower bound, never a false "short".
        let bytes = geometry(type_id)
            .filter(|(block, _)| elements.is_multiple_of(*block as u128))
            .map(|(block, size)| elements / block as u128 * size as u128)
            .unwrap_or(0);
        end = end.max((offset as u128).saturating_add(bytes).min(u64::MAX as u128) as u64);
    }
    let data_start = r.pos.div_ceil(alignment).saturating_mul(alignment);
    header.need_bytes = if tensors == 0 {
        // A metadata-only shard ends at its header: the padding before an empty data section is not written.
        r.pos
    } else {
        data_start.saturating_add(end)
    };
    Ok(Some(header))
}

#[cfg(test)]
pub(crate) mod fixture {
    //! Writes small but structurally real GGUF files for tests.
    use std::{fs, io::Write, path::Path};

    pub struct Tensor {
        pub name: &'static str,
        pub dims: Vec<u64>,
        pub type_id: u32,
    }

    fn string(out: &mut Vec<u8>, s: &str) {
        out.extend((s.len() as u64).to_le_bytes());
        out.extend(s.as_bytes());
    }

    /// A GGUF v3 file with `split.no`/`split.count` (when given), a token array, and `tensors` laid out with
    /// 32-byte alignment. `cut` removes bytes from the end (a truncated copy).
    pub fn write(path: &Path, split: Option<(u16, u16)>, tensors: &[Tensor], cut: u64) -> u64 {
        write_arch(path, "qwen4exp", split, tensors, cut)
    }

    /// [`write`] with another `general.architecture` (Qwen3.8-Flash-Next's is `qwen4exp`).
    pub fn write_arch(
        path: &Path,
        architecture: &str,
        split: Option<(u16, u16)>,
        tensors: &[Tensor],
        cut: u64,
    ) -> u64 {
        let mut out = Vec::new();
        out.extend(b"GGUF");
        out.extend(3_u32.to_le_bytes());
        out.extend((tensors.len() as u64).to_le_bytes());
        let kvs = 2 + if split.is_some() { 2 } else { 0 };
        out.extend((kvs as u64).to_le_bytes());
        string(&mut out, "general.architecture");
        out.extend(8_u32.to_le_bytes());
        string(&mut out, architecture);
        string(&mut out, "tokenizer.ggml.tokens");
        out.extend(9_u32.to_le_bytes());
        out.extend(8_u32.to_le_bytes());
        out.extend(3_u64.to_le_bytes());
        for t in ["<s>", "a", "b"] {
            string(&mut out, t);
        }
        if let Some((no, count)) = split {
            string(&mut out, "split.no");
            out.extend(2_u32.to_le_bytes());
            out.extend(no.to_le_bytes());
            string(&mut out, "split.count");
            out.extend(2_u32.to_le_bytes());
            out.extend(count.to_le_bytes());
        }
        let mut offset = 0_u64;
        let mut end = 0_u64;
        for t in tensors {
            string(&mut out, t.name);
            out.extend((t.dims.len() as u32).to_le_bytes());
            for d in &t.dims {
                out.extend(d.to_le_bytes());
            }
            out.extend(t.type_id.to_le_bytes());
            out.extend(offset.to_le_bytes());
            let (block, size) = super::geometry(t.type_id).unwrap();
            let bytes = t.dims.iter().product::<u64>() / block * size;
            end = offset + bytes;
            offset = end.div_ceil(32) * 32;
        }
        // The last tensor's padding is not required: the file ends with its data.
        let total = if tensors.is_empty() {
            out.len() as u64
        } else {
            (out.len() as u64).div_ceil(32) * 32 + end
        };
        let mut file = fs::File::create(path).unwrap();
        file.write_all(&out).unwrap();
        let len = total.saturating_sub(cut);
        file.set_len(len).unwrap();
        len
    }
}

#[cfg(test)]
mod tests {
    use super::{fixture::*, *};

    fn tensors() -> Vec<Tensor> {
        vec![
            Tensor {
                name: "blk.0.ffn",
                dims: vec![256, 64],
                type_id: 14,
            },
            Tensor {
                name: "blk.0.attn",
                dims: vec![32, 33],
                type_id: 8,
            },
            Tensor {
                name: "output_norm",
                dims: vec![100],
                type_id: 0,
            },
        ]
    }

    #[test]
    fn a_metadata_only_first_split_is_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m-00001-of-00006.gguf");
        write(&path, Some((0, 6)), &[], 0);
        match check(&path) {
            ShardCheck::Whole(h) => {
                assert_eq!(
                    (h.tensors, h.split_no, h.split_count),
                    (0, Some(0), Some(6))
                )
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_full_shard_is_whole_and_a_truncated_one_is_short() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m-00002-of-00006.gguf");
        let len = write(&path, Some((1, 6)), &tensors(), 0);
        assert!(
            matches!(check(&path), ShardCheck::Whole(h) if h.need_bytes == len),
            "{:?}",
            check(&path)
        );
        write(&path, Some((1, 6)), &tensors(), 10);
        assert!(
            matches!(check(&path), ShardCheck::Short { have, need: Some(need) } if need == have + 10)
        );
        // Cut inside the header itself.
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(40)
            .unwrap();
        assert!(matches!(check(&path), ShardCheck::Short { need: None, .. }));
    }

    #[test]
    fn other_files_are_not_gguf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.gguf");
        fs::write(&path, vec![0_u8; 4096]).unwrap();
        assert_eq!(check(&path), ShardCheck::NotGguf);
        fs::write(&path, b"").unwrap();
        assert_eq!(check(&path), ShardCheck::NotGguf);
        assert!(matches!(
            check(&dir.path().join("none.gguf")),
            ShardCheck::Unreadable(_)
        ));
    }
}
