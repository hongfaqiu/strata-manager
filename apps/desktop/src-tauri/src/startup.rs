//! Login starts the independently staged supervisor, never a hidden WebView.
use serde_json::{json, Value};
use std::path::Path;

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
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::*,
    };
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE: &str = "Strata Manager Supervisor";
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
        let key = open(path)?;
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
        let length = bytes.iter().position(|v| *v == 0).unwrap_or(bytes.len());
        Ok(Some(String::from_utf16_lossy(&bytes[..length])))
    }
    fn write(path: &str, name: &str, value: Option<&str>) -> Result<(), String> {
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
    pub fn status() -> Result<Value, String> {
        Ok(json!({"enabled":read(KEY,VALUE)?.is_some(),"supported":true,"backgroundOnly":true}))
    }
    pub fn set(enabled: bool, executable: &Path, data: &Path) -> Result<Value, String> {
        let command = command_line(executable, data);
        write(KEY, VALUE, enabled.then_some(command.as_str()))?;
        status()
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
    pub fn status() -> Result<Value, String> {
        Ok(json!({"enabled":path()?.is_file(),"supported":true,"backgroundOnly":true}))
    }
    pub fn set(enabled: bool, executable: &Path, data: &Path) -> Result<Value, String> {
        let path = path()?;
        if enabled {
            use std::os::unix::fs::PermissionsExt;
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let escape = |p: &Path| {
                format!(
                    "\"{}\"",
                    p.to_string_lossy()
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('`', "\\`")
                        .replace('$', "\\$")
                        .replace('%', "%%")
                )
            };
            fs::write(&path,format!("[Desktop Entry]\nType=Application\nName=Strata Manager background service\nExec={} --data-dir {}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n",escape(executable),escape(data))).map_err(|e|e.to_string())?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        status()
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::*;
    pub fn status() -> Result<Value, String> {
        Ok(
            json!({"enabled":false,"supported":false,"backgroundOnly":true,"reason":"当前平台尚未配置独立后台登录启动"}),
        )
    }
    pub fn set(_enabled: bool, _executable: &Path, _data: &Path) -> Result<Value, String> {
        Err("当前平台尚未支持独立后台登录启动".into())
    }
}

pub use platform::{set, status};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_line_quotes_each_argument_without_shell_expansion() {
        let command = command_line(
            Path::new(r"C:\App Files\strata-supervisor.exe"),
            Path::new(r"C:\Model Data\"),
        );
        assert_eq!(
            command,
            r#""C:\App Files\strata-supervisor.exe" --data-dir "C:\Model Data\\""#
        );
        assert!(!command.contains("strata-manager.exe"));
    }
}
