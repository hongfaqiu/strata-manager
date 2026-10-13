//! Image exports are local UI work: saving a preview never requires a running
//! Supervisor or changes the lifecycle of the model service.
use std::{io::Write, path::Path};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_EDGE: u32 = 8192;
const MAX_PIXELS: u64 = 32 * 1024 * 1024;
const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

const fn crc_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 != 0 {
                0xedb8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}
const CRC_TABLE: [u32; 256] = crc_table();

fn crc(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(!0u32, |value, byte| {
        CRC_TABLE[((value ^ u32::from(*byte)) & 255) as usize] ^ (value >> 8)
    })
}

fn u32_be(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("four-byte PNG field"))
}

// Validate the bounded PNG envelope and each chunk's checksum. The image was
// rendered and encoded by the frontend canvas; do not decode its full pixel
// buffer again merely to save the already-previewed bytes.
fn validate(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES {
        return Err("图片超过 64 MiB / Image exceeds 64 MiB".into());
    }
    if !bytes.starts_with(SIGNATURE) {
        return Err("图片不是 PNG / Image is not PNG".into());
    }
    let mut offset = SIGNATURE.len();
    let mut header = false;
    let mut palette = false;
    let mut indexed = false;
    let mut image_bytes = 0usize;
    let mut image_ended = false;
    while offset + 12 <= bytes.len() {
        let length = u32_be(&bytes[offset..offset + 4]) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(length))
            .filter(|end| *end <= bytes.len())
            .ok_or("PNG 数据不完整 / PNG data is truncated")?;
        let kind = &bytes[offset + 4..offset + 8];
        let data = &bytes[offset + 8..end - 4];
        if !kind.iter().all(u8::is_ascii_alphabetic)
            || crc(&bytes[offset + 4..end - 4]) != u32_be(&bytes[end - 4..end])
        {
            return Err("PNG 数据校验失败 / PNG checksum is invalid".into());
        }
        if !header && kind != b"IHDR" {
            return Err("PNG 图片头缺失 / PNG header is missing".into());
        }
        match kind {
            b"IHDR" => {
                if header || length != 13 {
                    return Err("PNG 图片头无效 / PNG header is invalid".into());
                }
                let width = u32_be(&data[..4]);
                let height = u32_be(&data[4..8]);
                if width == 0
                    || height == 0
                    || width > MAX_EDGE
                    || height > MAX_EDGE
                    || u64::from(width) * u64::from(height) > MAX_PIXELS
                {
                    return Err("PNG 图片尺寸超出限制 / PNG dimensions exceed the limit".into());
                }
                let valid_depth = match data[9] {
                    0 => matches!(data[8], 1 | 2 | 4 | 8 | 16),
                    2 | 4 | 6 => matches!(data[8], 8 | 16),
                    3 => matches!(data[8], 1 | 2 | 4 | 8),
                    _ => false,
                };
                if !valid_depth || data[10] != 0 || data[11] != 0 || data[12] > 1 {
                    return Err("PNG 编码参数无效 / PNG encoding parameters are invalid".into());
                }
                indexed = data[9] == 3;
                header = true;
            }
            b"PLTE" => {
                if palette || image_bytes > 0 || length == 0 || length > 768 || !length.is_multiple_of(3) {
                    return Err("PNG 调色板无效 / PNG palette is invalid".into());
                }
                palette = true;
            }
            b"IDAT" => {
                if image_ended || (indexed && !palette) {
                    return Err("PNG 图像数据无效 / PNG image data is invalid".into());
                }
                image_bytes += length;
            }
            b"IEND" => {
                if length != 0 || image_bytes == 0 || end != bytes.len() {
                    return Err("PNG 结束标记无效 / PNG end marker is invalid".into());
                }
                return Ok(());
            }
            _ => {
                if kind[0].is_ascii_uppercase() {
                    return Err("PNG 包含未知必要数据 / PNG has an unknown critical chunk".into());
                }
                if image_bytes > 0 {
                    image_ended = true;
                }
            }
        }
        offset = end;
    }
    Err("PNG 数据不完整 / PNG data is truncated".into())
}

pub(crate) fn save(path: &Path, bytes: &[u8]) -> Result<String, String> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("png"))
    {
        return Err(
            "导出文件必须为绝对路径的 .png 文件 / An absolute .png path is required".into(),
        );
    }
    #[cfg(windows)]
    if path
        .file_name()
        .is_some_and(|value| value.to_string_lossy().contains(':'))
    {
        return Err("导出文件名无效 / Export filename is invalid".into());
    }
    validate(bytes)?;
    if path.is_dir() || path.is_symlink() {
        return Err(
            "导出目标不能是目录或符号链接 / Export target cannot be a directory or symlink".into(),
        );
    }
    let parent = dunce::canonicalize(path.parent().ok_or("导出文件缺少父目录")?)
        .map_err(|error| format!("导出目录不可用 / Export directory is unavailable: {error}"))?;
    let destination = parent.join(path.file_name().ok_or("导出文件名为空")?);
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建导出文件 / Cannot create export file: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("PNG 保存失败 / PNG save failed: {error}"))?;
    temporary
        .persist(&destination)
        .map_err(|error| format!("PNG 保存失败 / PNG save failed: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = png.len();
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        png.extend_from_slice(&crc(&png[start..]).to_be_bytes());
    }

    fn image(width: u32, height: u32) -> Vec<u8> {
        let mut png = SIGNATURE.to_vec();
        let mut header = width.to_be_bytes().to_vec();
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(&mut png, b"IHDR", &header);
        // A real, uncompressed zlib stream for one RGBA black pixel. Tests of
        // oversized IHDR fields fail before any file or pixel allocation.
        chunk(
            &mut png,
            b"IDAT",
            &[0x78, 1, 1, 5, 0, 0xfa, 0xff, 0, 0, 0, 0, 0xff, 1, 4, 1, 0],
        );
        chunk(&mut png, b"IEND", &[]);
        png
    }

    #[test]
    fn uses_the_standard_png_crc32() {
        assert_eq!(crc(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn saves_exact_bytes_to_selected_unicode_folder_and_atomically_replaces_file() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("自选位置");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("测试结果.PNG");
        let png = image(1, 1);
        let saved = save(&path, &png).unwrap();
        assert_eq!(Path::new(&saved), dunce::canonicalize(&path).unwrap());
        assert_eq!(fs::read(&path).unwrap(), png);
        fs::write(&path, "old export").unwrap();
        save(&path, &png).unwrap();
        assert_eq!(fs::read(&path).unwrap(), png);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn rejects_corrupt_or_truncated_png_without_replacing_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("keep.png");
        fs::write(&path, "keep").unwrap();
        let png = image(1, 1);
        let mut corrupt = png.clone();
        corrupt[45] ^= 1;
        let mut trailing = png.clone();
        trailing.push(0);
        for invalid in [b"not a png".to_vec(), png[..40].to_vec(), corrupt, trailing] {
            assert!(save(&path, &invalid).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"keep");
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_unbounded_dimensions_and_byte_count() {
        for (width, height) in [(0, 1), (8193, 1), (1, 8193), (8192, 4097)] {
            assert!(validate(&image(width, height))
                .unwrap_err()
                .contains("尺寸"));
        }
        assert!(validate(&vec![0; MAX_BYTES + 1])
            .unwrap_err()
            .contains("64 MiB"));
    }

    #[test]
    fn requires_absolute_png_file_in_existing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("directory.png");
        fs::create_dir(&directory).unwrap();
        for path in [
            Path::new("relative.png").to_path_buf(),
            temp.path().join("config.json"),
            temp.path().join("missing/result.png"),
            directory,
        ] {
            assert!(save(&path, &image(1, 1)).is_err());
        }
        #[cfg(windows)]
        assert!(save(&temp.path().join("result.png:other.png"), &image(1, 1)).is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_target() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.png");
        let link = temp.path().join("link.png");
        fs::write(&original, "keep").unwrap();
        std::os::unix::fs::symlink(&original, &link).unwrap();
        assert!(save(&link, &image(1, 1)).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"keep");
    }
}
