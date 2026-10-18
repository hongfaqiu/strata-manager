//! Login starts the independently staged supervisor, never a hidden WebView.
use serde_json::Value;
#[cfg(not(any(windows, target_os = "linux")))]
use serde_json::json;
use std::path::Path;
// startup_status_tests.rs reaches these through `use super::*`.
#[cfg(test)]
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::{fs, path::PathBuf};

#[cfg(any(windows, target_os = "linux", test))]
mod registration {
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::Read,
        path::{Path, PathBuf},
    };

    pub(super) enum Registration {
        Missing,
        Invalid(&'static str),
        Command(Vec<String>, Option<&'static str>),
    }

    pub(super) fn reason(code: &str) -> &'static str {
        match code {
            "disabled_entry" => "系统已禁用此启动项。请在系统启动设置中启用，或在应用中重新开启。",
            "restricted_entry" => {
                "启动项含桌面环境限制或额外启动条件。请核对系统启动设置后重新启用。"
            }
            "missing_executable" => {
                "已配置的后台文件不存在。请重新开启此项以修复；若仍失败，请修复应用安装。"
            }
            "corrupt_executable" => {
                "已配置的后台文件校验失败。请修复应用安装，再重新开启此启动项。"
            }
            "wrong_data" => {
                "此启动项使用其它数据目录。请在系统启动设置中移除同名项，再在本应用中启用。"
            }
            "foreign_entry" => {
                "同名启动项不属于本应用的独立后台。请在系统启动设置中核对并移除，再启用本应用。"
            }
            "unreadable_entry" => "启动项无法读取。请检查系统启动设置和文件权限后重试。",
            _ => "启动项内容无效。请在系统启动设置中移除同名项，再在本应用中重新启用。",
        }
    }

    pub(super) fn status_value(registration: &Registration, data: &Path) -> Value {
        let configured = !matches!(registration, Registration::Missing);
        let mut status = json!({"configured":configured,"enabled":false,"healthy":false,"supported":true,"backgroundOnly":false});
        let checked = match registration {
            Registration::Missing => {
                status["backgroundOnly"] = json!(true);
                return status;
            }
            Registration::Invalid(code) => Err(*code),
            Registration::Command(args, inhibited) => match identity(args, data) {
                Ok((executable, version, expected_hash)) => {
                    status["backgroundOnly"] = json!(true);
                    status["registeredVersion"] = json!(version);
                    if let Some(code) = inhibited {
                        Err(*code)
                    } else {
                        executable_hash(&executable, &expected_hash).map(|hash| {
                            status["enabled"] = json!(true);
                            status["healthy"] = json!(true);
                            status["executableHash"] = json!(hash);
                        })
                    }
                }
                Err(code) => Err(code),
            },
        };
        if let Err(code) = checked {
            status["reasonCode"] = json!(code);
            status["reason"] = json!(reason(code));
        }
        status
    }

    pub(super) fn identity(
        args: &[String],
        data: &Path,
    ) -> Result<(PathBuf, String, String), &'static str> {
        identity_with_paths(args, data, &|path| dunce::canonicalize(path))
    }

    pub(super) fn linked_metadata(metadata: &fs::Metadata) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // Reject all reparse tags, including junctions and non-symlink tags.
            if metadata.file_attributes() & 0x400 != 0 {
                return true;
            }
        }
        metadata.file_type().is_symlink()
    }

    pub(super) fn identity_with_paths(
        args: &[String],
        data: &Path,
        canonicalize: &impl Fn(&Path) -> std::io::Result<PathBuf>,
    ) -> Result<(PathBuf, String, String), &'static str> {
        if args.len() != 3 || args[1] != "--data-dir" {
            return Err("foreign_entry");
        }
        let wanted_data = canonicalize(data).map_err(|_| "unreadable_entry")?;
        let registered_data = Path::new(&args[2]);
        if !registered_data.is_absolute()
            || canonicalize(registered_data).ok().as_ref() != Some(&wanted_data)
        {
            return Err("wrong_data");
        }
        let executable = Path::new(&args[0]);
        let filename = if cfg!(windows) {
            "strata-supervisor.exe"
        } else {
            "strata-supervisor"
        };
        let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
        if !executable.is_absolute()
            || executable.file_name().and_then(|v| v.to_str()) != Some(filename)
            || args[0]
                .split(separators)
                .any(|part| matches!(part, "." | ".."))
        {
            return Err("foreign_entry");
        }
        let directory = executable.parent().ok_or("foreign_entry")?;
        let name = directory
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("foreign_entry")?;
        let (version, hash) = name.rsplit_once('-').ok_or("foreign_entry")?;
        let release = version
            .split_once('-')
            .map_or(version, |(release, _)| release);
        if release.split('.').count() != 3
            || release
                .split('.')
                .any(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
            || version.len() > 80
            || !version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
            || hash.len() != 16
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("foreign_entry");
        }
        let root_path = directory.parent().ok_or("foreign_entry")?;
        if root_path.file_name().and_then(|v| v.to_str()) != Some("supervisor")
            || canonicalize(root_path.parent().ok_or("foreign_entry")?)
                .ok()
                .as_ref()
                != Some(&wanted_data)
        {
            return Err("foreign_entry");
        }
        // A removed staging directory is still an owned registration when its
        // strict, dot-free hierarchy sits immediately below the known data directory.
        // Existing links or unexpected objects must never use this missing-path rule.
        let expected_root = wanted_data.join("supervisor");
        match fs::symlink_metadata(root_path) {
            Ok(metadata) => {
                if !metadata.is_dir() || linked_metadata(&metadata) {
                    return Err("foreign_entry");
                }
                let actual = canonicalize(root_path).map_err(|_| "unreadable_entry")?;
                let expected = canonicalize(&expected_root).map_err(|_| "unreadable_entry")?;
                if actual != expected
                    || actual.file_name().and_then(|v| v.to_str()) != Some("supervisor")
                {
                    return Err("foreign_entry");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("unreadable_entry"),
        }
        // Accept any retained staged version, including the previous package during
        // a rolling upgrade. Never require the currently running package's path.
        match fs::symlink_metadata(directory) {
            Ok(metadata) => {
                if !metadata.is_dir() || linked_metadata(&metadata) {
                    return Err("foreign_entry");
                }
                // Windows may resolve an existing child to a physical mapped path
                // while its parent retains its logical spelling. Resolve the whole
                // expected child from the trusted data root instead of appending to
                // a separately resolved parent. Strict ancestry and reparse guards
                // above still apply to the registration's original path.
                let actual = canonicalize(directory).map_err(|_| "unreadable_entry")?;
                let expected =
                    canonicalize(&expected_root.join(name)).map_err(|_| "unreadable_entry")?;
                if actual != expected || actual.file_name().and_then(|v| v.to_str()) != Some(name) {
                    return Err("foreign_entry");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("unreadable_entry"),
        }
        Ok((
            executable.to_owned(),
            version.to_owned(),
            hash.to_ascii_lowercase(),
        ))
    }

    pub(super) fn executable_hash(
        executable: &Path,
        expected: &str,
    ) -> Result<String, &'static str> {
        let before = fs::symlink_metadata(executable).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "missing_executable"
            } else {
                "unreadable_entry"
            }
        })?;
        if !before.is_file()
            || linked_metadata(&before)
            || before.len() < 4
            || before.len() > 512 * 1024 * 1024
        {
            return Err("corrupt_executable");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if before.permissions().mode() & 0o111 == 0 {
                return Err("corrupt_executable");
            }
        }
        let mut file = fs::File::open(executable).map_err(|_| "unreadable_entry")?;
        let mut header = [0u8; 4];
        file.read_exact(&mut header)
            .map_err(|_| "corrupt_executable")?;
        if (cfg!(windows) && &header[..2] != b"MZ")
            || (cfg!(target_os = "linux") && &header != b"\x7fELF")
        {
            return Err("corrupt_executable");
        }
        let mut hash = Sha256::new();
        hash.update(header);
        let mut consumed = 4u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|_| "unreadable_entry")?;
            if count == 0 {
                break;
            }
            consumed += count as u64;
            if consumed > before.len() {
                return Err("corrupt_executable");
            }
            hash.update(&buffer[..count]);
        }
        let after = fs::symlink_metadata(executable).map_err(|_| "missing_executable")?;
        let digest = format!("{:x}", hash.finalize());
        if consumed != before.len()
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
            || !after.is_file()
            || linked_metadata(&after)
            || !digest.starts_with(expected)
        {
            return Err("corrupt_executable");
        }
        Ok(digest)
    }

    pub(super) fn may_replace(registration: &Registration, data: &Path) -> Result<(), String> {
        match registration {
            Registration::Missing => Ok(()),
            Registration::Command(args, _) => identity(args, data)
                .map(|_| ())
                .map_err(|code| reason(code).into()),
            Registration::Invalid(code) => Err(reason(code).into()),
        }
    }
}
#[cfg(any(windows, target_os = "linux", test))]
use registration::*;

#[cfg(any(windows, test))]
pub fn command_line(executable: &Path, data: &Path) -> String {
    fn quote(value: &str) -> String {
        let mut out = String::from("\"");
        let mut slashes = 0;
        for character in value.chars() {
            if character == '\\' {
                slashes += 1;
                continue;
            }
            if character == '\"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
            } else {
                out.push_str(&"\\".repeat(slashes));
                out.push(character);
            }
            slashes = 0;
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }
    format!(
        "{} --data-dir {}",
        quote(&executable.to_string_lossy()),
        quote(&data.to_string_lossy())
    )
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::*,
        UI::Shell::CommandLineToArgvW,
    };
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    pub(super) const VALUE: &str = "Strata Manager Supervisor";
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn open(path: &str) -> Result<Key, String> {
        let mut handle = ptr::null_mut();
        let result = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(path).as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                ptr::null(),
                &mut handle,
                ptr::null_mut(),
            )
        };
        if result != ERROR_SUCCESS {
            return Err(format!("无法访问当前用户登录启动设置: Windows {result}"));
        }
        Ok(Key(handle))
    }
    fn read(path: &str, name: &str) -> Result<Option<String>, String> {
        let mut handle = ptr::null_mut();
        let result = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide(path).as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut handle,
            )
        };
        if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS {
            return Err(format!("无法读取登录启动设置: Windows {result}"));
        }
        let key = Key(handle);
        let name = wide(name);
        let mut size = 0;
        let result = unsafe {
            RegGetValueW(
                key.0,
                ptr::null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut size,
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS || size > 64 * 1024 {
            return Err(format!("无法读取登录启动设置: Windows {result}"));
        }
        let mut bytes = vec![0u16; (size as usize).div_ceil(2)];
        let result = unsafe {
            RegGetValueW(
                key.0,
                ptr::null(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                bytes.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        if result != ERROR_SUCCESS {
            return Err(format!("无法读取登录启动设置: Windows {result}"));
        }
        if size < 2 || size % 2 != 0 {
            return Err("启动项内容无效".into());
        }
        bytes.truncate(size as usize / 2);
        if bytes.last() != Some(&0) {
            return Err("启动项内容无效".into());
        }
        bytes.pop();
        if bytes.contains(&0) {
            return Err("启动项内容无效".into());
        }
        String::from_utf16(&bytes)
            .map(Some)
            .map_err(|_| "启动项内容无效".into())
    }
    pub(super) fn write(path: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        let key = open(path)?;
        let name = wide(name);
        let result = match value {
            Some(value) => {
                let content = wide(value);
                unsafe {
                    RegSetValueExW(
                        key.0,
                        name.as_ptr(),
                        0,
                        REG_SZ,
                        content.as_ptr() as *const _,
                        (content.len() * 2) as u32,
                    )
                }
            }
            None => unsafe { RegDeleteValueW(key.0, name.as_ptr()) },
        };
        if result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("设置登录启动失败: Windows {result}"))
        }
    }
    pub(super) fn arguments(command: &str) -> Result<Vec<String>, &'static str> {
        if command.is_empty()
            || command.encode_utf16().count() > 32767
            || command.chars().any(char::is_control)
        {
            return Err("invalid_entry");
        }
        let text = wide(command);
        let mut count = 0;
        unsafe {
            let pointers = CommandLineToArgvW(text.as_ptr(), &mut count);
            if pointers.is_null() {
                return Err("invalid_entry");
            }
            let result = (|| {
                if count != 3 {
                    return Err("foreign_entry");
                }
                let mut args = Vec::new();
                for index in 0..count as usize {
                    let pointer = *pointers.add(index);
                    let mut length = 0;
                    while *pointer.add(length) != 0 {
                        length += 1;
                    }
                    args.push(
                        String::from_utf16(std::slice::from_raw_parts(pointer, length))
                            .map_err(|_| "invalid_entry")?,
                    );
                }
                Ok(args)
            })();
            LocalFree(pointers as _);
            result
        }
    }
    fn registration(path: &str) -> Result<Registration, String> {
        match read(path, VALUE) {
            Ok(None) => Ok(Registration::Missing),
            Ok(Some(command)) => Ok(match arguments(&command) {
                Ok(args) => Registration::Command(args, None),
                Err(code) => Registration::Invalid(code),
            }),
            // A value of another registry type or malformed UTF-16 is still a
            // configured item. Never report it as enabled or silently replace it.
            Err(error) if error == "启动项内容无效" || error.contains("Windows 1630") => {
                Ok(Registration::Invalid("invalid_entry"))
            }
            Err(error) => Err(error),
        }
    }
    pub(super) fn status_at(path: &str, data: &Path) -> Result<Value, String> {
        Ok(status_value(&registration(path)?, data))
    }
    pub fn status(data: &Path) -> Result<Value, String> {
        status_at(KEY, data)
    }
    pub(super) fn set_at(
        path: &str,
        enabled: bool,
        executable: &Path,
        data: &Path,
    ) -> Result<Value, String> {
        let existing = registration(path)?;
        may_replace(&existing, data)?;
        if enabled {
            let args = vec![
                executable.to_string_lossy().into_owned(),
                "--data-dir".into(),
                data.to_string_lossy().into_owned(),
            ];
            let (path, _, hash) = identity(&args, data).map_err(reason)?;
            executable_hash(&path, &hash).map_err(reason)?;
        }
        let command = command_line(executable, data);
        write(path, VALUE, enabled.then_some(command.as_str()))?;
        status_at(path, data)
    }
    pub fn set(enabled: bool, executable: &Path, data: &Path) -> Result<Value, String> {
        set_at(KEY, enabled, executable, data)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn startup_registry_roundtrip_uses_isolated_hkcu_key_and_no_gui() {
            let name = format!("Software\\StrataManager\\Test-{}", uuid::Uuid::new_v4());
            let command = command_line(
                Path::new(r"C:\Test App\strata-supervisor.exe"),
                Path::new(r"C:\Test Data\local"),
            );
            assert!(read(&name, VALUE).unwrap().is_none());
            write(&name, VALUE, Some(&command)).unwrap();
            assert_eq!(read(&name, VALUE).unwrap(), Some(command));
            write(&name, VALUE, None).unwrap();
            assert!(read(&name, VALUE).unwrap().is_none());
            unsafe {
                assert_eq!(
                    RegDeleteKeyW(HKEY_CURRENT_USER, wide(&name).as_ptr()),
                    ERROR_SUCCESS
                );
            }
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn desktop_command(executable: &Path, data: &Path) -> Result<String, String> {
    fn quote(path: &Path) -> Result<String, String> {
        let text = path.to_str().ok_or("启动路径必须是有效 UTF-8")?;
        if text.chars().any(char::is_control) || text.contains('=') {
            return Err("启动路径包含不支持的字符".into());
        }
        // Desktop Entry string unescaping precedes Exec quoting; escape twice.
        // https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html
        let mut argument = String::from("\"");
        for c in text.chars() {
            if matches!(c, '\\' | '"' | '`' | '$') {
                argument.push('\\');
            }
            if c == '%' {
                argument.push('%');
            }
            argument.push(c);
        }
        argument.push('"');
        Ok(argument.replace('\\', "\\\\"))
    }
    Ok(format!(
        "{} --data-dir {}",
        quote(executable)?,
        quote(data)?
    ))
}

#[cfg(any(target_os = "linux", test))]
fn desktop_arguments(raw: &str) -> Result<Vec<String>, &'static str> {
    let mut decoded = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            decoded.push(match chars.next() {
                Some('\\') => '\\',
                Some('s') => ' ',
                Some('n') => '\n',
                Some('r') => '\r',
                Some('t') => '\t',
                _ => return Err("invalid_entry"),
            });
        } else {
            decoded.push(c);
        }
    }
    if decoded.len() > 64 * 1024 || decoded.chars().any(char::is_control) {
        return Err("invalid_entry");
    }
    let mut args = Vec::new();
    let mut chars = decoded.chars().peekable();
    while chars.peek().is_some() {
        while chars.peek() == Some(&' ') {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let quoted = chars.peek() == Some(&'"');
        if quoted {
            chars.next();
        }
        let mut value = String::new();
        let mut closed = !quoted;
        while let Some(c) = chars.next() {
            if quoted && c == '"' {
                closed = true;
                break;
            }
            if !quoted && c == ' ' {
                break;
            }
            if c == '\\' && quoted {
                match chars.next() {
                    Some(c @ ('\\' | '"' | '`' | '$')) => value.push(c),
                    _ => return Err("invalid_entry"),
                }
            } else if c == '%' {
                if chars.next() != Some('%') {
                    return Err("invalid_entry");
                }
                value.push('%');
            } else if (!quoted && "\"'\\><~|&;$*?#()`".contains(c))
                || (quoted && matches!(c, '`' | '$'))
            {
                return Err("invalid_entry");
            } else {
                value.push(c);
            }
        }
        if !closed || (quoted && chars.peek().is_some_and(|c| *c != ' ')) {
            return Err("invalid_entry");
        }
        args.push(value);
        if args.len() > 3 {
            return Err("foreign_entry");
        }
    }
    if args.len() != 3 {
        return Err("foreign_entry");
    }
    Ok(args)
}

#[cfg(any(target_os = "linux", test))]
fn desktop_registration(text: &str) -> Registration {
    let mut values = std::collections::BTreeMap::new();
    let mut active = false;
    let mut seen = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            active = line == "[Desktop Entry]";
            if active && seen {
                return Registration::Invalid("invalid_entry");
            }
            seen |= active;
        } else if active {
            let Some((key, value)) = line.split_once('=') else {
                return Registration::Invalid("invalid_entry");
            };
            if values.insert(key.trim(), value.trim()).is_some() {
                return Registration::Invalid("invalid_entry");
            }
        }
    }
    if values.get("Type") != Some(&"Application") {
        return Registration::Invalid("invalid_entry");
    }
    let Some(command) = values.get("Exec") else {
        return Registration::Invalid("invalid_entry");
    };
    let args = match desktop_arguments(command) {
        Ok(args) => args,
        Err(code) => return Registration::Invalid(code),
    };
    let mut inhibited = None;
    for key in [
        "Hidden",
        "Terminal",
        "DBusActivatable",
        "X-GNOME-Autostart-enabled",
    ] {
        if let Some(value) = values.get(key) {
            if !matches!(*value, "true" | "false") {
                return Registration::Invalid("invalid_entry");
            }
            if (key == "X-GNOME-Autostart-enabled" && *value == "false")
                || (key == "Hidden" && *value == "true")
            {
                inhibited = Some("disabled_entry");
            } else if *value == "true" && matches!(key, "Terminal" | "DBusActivatable") {
                inhibited = Some("restricted_entry");
            }
        }
    }
    if [
        "OnlyShowIn",
        "NotShowIn",
        "TryExec",
        "X-KDE-autostart-condition",
    ]
    .into_iter()
    .any(|key| values.get(key).is_some_and(|v| !v.is_empty()))
    {
        inhibited = Some("restricted_entry");
    }
    Registration::Command(args, inhibited)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{fs, path::PathBuf};
    fn path() -> Result<PathBuf, String> {
        let directory = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
            .ok_or("无法定位当前用户配置目录")?;
        if !directory.is_absolute() {
            return Err("当前用户配置目录必须是绝对路径".into());
        }
        Ok(directory.join("autostart/io.strata.manager.supervisor.desktop"))
    }
    fn registration(path: &Path) -> Result<Registration, String> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registration::Missing)
            }
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
            return Ok(Registration::Invalid("invalid_entry"));
        }
        Ok(match fs::read_to_string(path) {
            Ok(text) => desktop_registration(&text),
            Err(_) => Registration::Invalid("unreadable_entry"),
        })
    }
    pub(super) fn status_at(path: &Path, data: &Path) -> Result<Value, String> {
        Ok(status_value(&registration(path)?, data))
    }
    pub fn status(data: &Path) -> Result<Value, String> {
        status_at(&path()?, data)
    }
    pub(super) fn set_at(
        path: &Path,
        enabled: bool,
        executable: &Path,
        data: &Path,
    ) -> Result<Value, String> {
        let existing = registration(path)?;
        may_replace(&existing, data)?;
        if enabled {
            use std::os::unix::fs::PermissionsExt;
            let args = vec![
                executable.to_string_lossy().into_owned(),
                "--data-dir".into(),
                data.to_string_lossy().into_owned(),
            ];
            let (executable, _, hash) = identity(&args, data).map_err(reason)?;
            executable_hash(&executable, &hash).map_err(reason)?;
            let command = desktop_command(&executable, data)?;
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(path,format!("[Desktop Entry]\nType=Application\nName=Strata Manager background service\nExec={command}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n")).map_err(|e|e.to_string())?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        status_at(path, data)
    }
    pub fn set(enabled: bool, executable: &Path, data: &Path) -> Result<Value, String> {
        set_at(&path()?, enabled, executable, data)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::*;
    pub fn status(_data: &Path) -> Result<Value, String> {
        Ok(
            json!({"configured":false,"enabled":false,"healthy":false,"supported":false,"backgroundOnly":true,"reasonCode":"unsupported","reason":"当前平台尚未配置独立后台登录启动"}),
        )
    }
    pub fn set(_enabled: bool, _executable: &Path, _data: &Path) -> Result<Value, String> {
        Err("当前平台尚未支持独立后台登录启动".into())
    }
}

pub use platform::{set, status};

#[cfg(test)]
#[path = "startup_status_tests.rs"]
mod tests;
