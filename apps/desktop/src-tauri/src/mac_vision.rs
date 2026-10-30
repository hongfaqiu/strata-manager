//! Whether this Mac can start the picture reader (`strata-vision`). The pinned macOS arm64 Metal engine package
//! (0.1.47) ships it linked for macOS 27 (LC_BUILD_VERSION minos 27.0), so older systems cannot run it.
//! Only the binary's Mach-O header is read; nothing is started.
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};

const LC_VERSION_MIN_MACOSX: u32 = 0x24;
const LC_BUILD_VERSION: u32 = 0x32;
const PLATFORM_MACOS: u32 = 1;
const CPU_TYPE_ARM64: u32 = 0x0100_000c;
/// Mach-O headers sit in the first pages; a fat slice is read from its offset.
const HEADER_LIMIT: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacVisionSupport {
    /// The binary's minimum macOS, e.g. "27.0".
    pub required: String,
    /// This Mac's macOS, e.g. "15.5".
    pub system: String,
    pub supported: bool,
}

fn u32_at(bytes: &[u8], offset: usize, big_endian: bool) -> Option<u32> {
    let raw: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(if big_endian {
        u32::from_be_bytes(raw)
    } else {
        u32::from_le_bytes(raw)
    })
}

/// (major, minor) from a Mach-O `xxxx.yy.zz` nibble-packed version.
fn packed(version: u32) -> (u32, u32) {
    (version >> 16, (version >> 8) & 0xff)
}

/// Minimum macOS of a thin 64-bit Mach-O image (LC_BUILD_VERSION for macOS, else LC_VERSION_MIN_MACOSX).
fn thin_minos(bytes: &[u8]) -> Option<(u32, u32)> {
    if u32_at(bytes, 0, false)? != 0xfeed_facf {
        return None;
    }
    let commands = u32_at(bytes, 16, false)?.min(4096);
    let mut offset = 32usize;
    let mut fallback = None;
    for _ in 0..commands {
        let command = u32_at(bytes, offset, false)?;
        let size = u32_at(bytes, offset + 4, false)? as usize;
        if size < 8 {
            return None;
        }
        if command == LC_BUILD_VERSION && u32_at(bytes, offset + 8, false)? == PLATFORM_MACOS {
            return Some(packed(u32_at(bytes, offset + 12, false)?));
        }
        if command == LC_VERSION_MIN_MACOSX {
            fallback = Some(packed(u32_at(bytes, offset + 8, false)?));
        }
        offset = offset.checked_add(size)?;
    }
    fallback
}

/// Minimum macOS of a Mach-O file's bytes: a thin image, or the arm64 slice of a universal one.
pub fn macho_minos(bytes: &[u8]) -> Option<(u32, u32)> {
    if u32_at(bytes, 0, true)? != 0xcafe_babe {
        return thin_minos(bytes);
    }
    let slices = u32_at(bytes, 4, true)?.min(16) as usize;
    (0..slices).find_map(|index| {
        let entry = 8 + index * 20;
        if u32_at(bytes, entry, true)? != CPU_TYPE_ARM64 {
            return None;
        }
        let start = u32_at(bytes, entry + 8, true)? as usize;
        thin_minos(bytes.get(start..)?)
    })
}

fn read_minos(path: &Path) -> Option<(u32, u32)> {
    let mut file = File::open(path).ok()?;
    let mut head = vec![0u8; HEADER_LIMIT];
    let read = file.read(&mut head).ok()?;
    head.truncate(read);
    if u32_at(&head, 0, true)? == 0xcafe_babe {
        // A universal binary: its arm64 slice header may be far into the file.
        let bytes = std::fs::read(path).ok()?;
        return macho_minos(&bytes);
    }
    macho_minos(&head)
}

/// (major, minor) of "15.5" / "26.0.1".
fn parse_version(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map(str::parse).transpose().ok()?.unwrap_or(0);
    Some((major, minor))
}

pub fn evaluate(required: (u32, u32), system: (u32, u32)) -> MacVisionSupport {
    MacVisionSupport {
        required: format!("{}.{}", required.0, required.1),
        system: format!("{}.{}", system.0, system.1),
        supported: system >= required,
    }
}

fn system_version() -> Option<(u32, u32)> {
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    parse_version(std::str::from_utf8(&output.stdout).ok()?)
}

/// `None` off macOS, or when the binary or the system version cannot be read (the file checks report a missing file).
pub fn support(exe: &Path) -> Option<MacVisionSupport> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    Some(evaluate(read_minos(exe)?, system_version()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thin(commands: &[(u32, Vec<u32>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (command, words) in commands {
            body.extend(command.to_le_bytes());
            body.extend((8 + 4 * words.len() as u32).to_le_bytes());
            for word in words {
                body.extend(word.to_le_bytes());
            }
        }
        let mut out = Vec::new();
        for word in [
            0xfeed_facf,
            CPU_TYPE_ARM64,
            0,
            2,
            commands.len() as u32,
            body.len() as u32,
            0,
            0,
        ] {
            out.extend(u32::to_le_bytes(word));
        }
        out.extend(body);
        out
    }

    #[test]
    fn reads_build_version_minos() {
        // LC_BUILD_VERSION platform macOS, minos 27.0, sdk 27.0, no tools.
        let image = thin(&[
            (0x19, vec![0; 4]),
            (LC_BUILD_VERSION, vec![1, 0x001b_0000, 0x001b_0000, 0]),
        ]);
        assert_eq!(macho_minos(&image), Some((27, 0)));
        let older = thin(&[(LC_VERSION_MIN_MACOSX, vec![0x000e_0000, 0x000f_0000])]);
        assert_eq!(macho_minos(&older), Some((14, 0)));
    }

    #[test]
    fn reads_the_arm64_slice_of_a_universal_binary() {
        let slice = thin(&[(LC_BUILD_VERSION, vec![1, 0x000f_0500, 0x001a_0000, 0])]);
        let mut fat = Vec::new();
        for word in [
            0xcafe_babe_u32,
            2,
            0x0100_0007,
            3,
            4096,
            64,
            12,
            CPU_TYPE_ARM64,
            0,
            64,
            slice.len() as u32,
            12,
        ] {
            fat.extend(word.to_be_bytes());
        }
        fat.resize(64, 0);
        fat.extend(&slice);
        assert_eq!(macho_minos(&fat), Some((15, 5)));
    }

    #[test]
    fn rejects_other_files_and_truncated_headers() {
        assert_eq!(macho_minos(b"MZ\x90\x00not a mach-o"), None);
        let image = thin(&[(LC_BUILD_VERSION, vec![1, 0x001b_0000, 0x001b_0000, 0])]);
        assert_eq!(macho_minos(&image[..40]), None);
    }

    #[test]
    fn compares_major_and_minor() {
        assert!(!evaluate((27, 0), (26, 1)).supported);
        assert!(!evaluate((27, 0), (15, 5)).supported);
        assert!(evaluate((27, 0), (27, 0)).supported);
        assert!(evaluate((14, 0), (15, 5)).supported);
        assert_eq!(parse_version("26.0.1\n"), Some((26, 0)));
        assert_eq!(parse_version("27"), Some((27, 0)));
        assert_eq!(evaluate((27, 0), (15, 5)).required, "27.0");
    }
}
