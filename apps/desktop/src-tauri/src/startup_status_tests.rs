use super::*;

#[cfg(windows)]
fn directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    // A junction fixture does not require Windows' symbolic-link privilege.
    // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer
    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            handle: *mut std::ffi::c_void,
            code: u32,
            input: *mut std::ffi::c_void,
            input_size: u32,
            output: *mut std::ffi::c_void,
            output_size: u32,
            returned: *mut u32,
            overlapped: *mut std::ffi::c_void,
        ) -> i32;
    }
    assert!(target.is_absolute() && link.is_absolute());
    fs::create_dir(link)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .custom_flags(0x0200_0000 | 0x0020_0000) // Backup semantics, open reparse point.
        .open(link)?;
    let display = target.to_str().unwrap();
    let substitute: Vec<_> = format!("\\??\\{display}").encode_utf16().collect();
    let printed: Vec<_> = display.encode_utf16().collect();
    let substitute_size = u16::try_from(substitute.len() * 2).unwrap();
    let print_size = u16::try_from(printed.len() * 2).unwrap();
    let data_size = u16::try_from(8 + usize::from(substitute_size + print_size) + 4).unwrap();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0xA000_0003u32.to_le_bytes()); // Mount point tag.
    for value in [
        data_size,
        0,
        0,
        substitute_size,
        substitute_size + 2,
        print_size,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for value in substitute
        .iter()
        .chain([&0])
        .chain(printed.iter())
        .chain([&0])
    {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let mut returned = 0;
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            0x0009_00A4, // FSCTL_SET_REPARSE_POINT.
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

struct Fixture {
    _temporary: tempfile::TempDir,
    data: PathBuf,
    executable: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let data = temporary.path().join("本机 数据");
        let bytes = fs::read(std::env::current_exe().unwrap()).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let directory = data
            .join("supervisor")
            .join(format!("0.0.1-beta.1-{}", &hash[..16]));
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join(if cfg!(windows) {
            "strata-supervisor.exe"
        } else {
            "strata-supervisor"
        });
        fs::write(&executable, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            _temporary: temporary,
            data,
            executable,
        }
    }
    fn args(&self) -> Vec<String> {
        vec![
            self.executable.to_string_lossy().into_owned(),
            "--data-dir".into(),
            self.data.to_string_lossy().into_owned(),
        ]
    }
    fn registration(&self) -> Registration {
        Registration::Command(self.args(), None)
    }
    fn remove_staging(&self) {
        let data = dunce::canonicalize(&self.data).unwrap();
        assert!(data.starts_with(dunce::canonicalize(self._temporary.path()).unwrap()));
        let root = dunce::canonicalize(data.join("supervisor")).unwrap();
        assert_eq!(root.parent(), Some(data.as_path()));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn absent_registration_is_not_configured_enabled_or_healthy() {
    let temp = tempfile::tempdir().unwrap();
    let status = status_value(&Registration::Missing, temp.path());
    assert_eq!(status["configured"], false);
    assert_eq!(status["enabled"], false);
    assert_eq!(status["healthy"], false);
    assert!(status.get("reason").is_none());
}

#[test]
fn retained_old_staged_version_is_valid_without_replacing_or_running_it() {
    let fixture = Fixture::new();
    let before = fs::read(&fixture.executable).unwrap();
    let status = status_value(&fixture.registration(), &fixture.data);
    assert_eq!(status["configured"], true);
    assert_eq!(status["enabled"], true);
    assert_eq!(status["healthy"], true);
    assert_eq!(status["registeredVersion"], "0.0.1-beta.1");
    assert_eq!(
        status["executableHash"],
        format!("{:x}", Sha256::digest(&before))
    );
    assert_eq!(fs::read(&fixture.executable).unwrap(), before);
}

#[test]
fn missing_or_modified_staged_executable_is_configured_but_needs_repair() {
    let fixture = Fixture::new();
    let bytes = fs::read(&fixture.executable).unwrap();
    fs::remove_file(&fixture.executable).unwrap();
    let missing = status_value(&fixture.registration(), &fixture.data);
    assert_eq!(missing["configured"], true);
    assert_eq!(missing["enabled"], false);
    assert_eq!(missing["healthy"], false);
    assert_eq!(missing["reasonCode"], "missing_executable");
    fs::write(&fixture.executable, &bytes).unwrap();
    let mut changed = bytes;
    changed.push(1);
    fs::write(&fixture.executable, changed).unwrap();
    let corrupt = status_value(&fixture.registration(), &fixture.data);
    assert_eq!(corrupt["reasonCode"], "corrupt_executable");
    assert_eq!(corrupt["enabled"], false);
}

#[test]
fn missing_entire_staging_directory_is_configured_but_owned_and_removable() {
    let fixture = Fixture::new();
    fixture.remove_staging();
    let registration = fixture.registration();
    let missing = status_value(&registration, &fixture.data);
    assert_eq!(missing["configured"], true);
    assert_eq!(missing["enabled"], false);
    assert_eq!(missing["healthy"], false);
    assert_eq!(missing["reasonCode"], "missing_executable");
    assert!(may_replace(&registration, &fixture.data).is_ok());
    assert!(!fixture.data.join("supervisor").exists());
}

#[test]
fn missing_staging_never_claims_dot_paths_other_ancestors_or_unknown_data() {
    let fixture = Fixture::new();
    fixture.remove_staging();
    let version = fixture.executable.parent().unwrap().file_name().unwrap();
    let filename = fixture.executable.file_name().unwrap();
    let root = fixture.data.join("supervisor");
    let foreign_paths = [
        root.join(".").join(version).join(filename),
        root.join("child").join("..").join(version).join(filename),
        fixture
            .data
            .join("nested/supervisor")
            .join(version)
            .join(filename),
        fixture
            ._temporary
            .path()
            .join("supervisor")
            .join(version)
            .join(filename),
    ];
    for path in foreign_paths {
        let mut args = fixture.args();
        args[0] = path.to_string_lossy().into_owned();
        let registration = Registration::Command(args, None);
        assert!(
            may_replace(&registration, &fixture.data).is_err(),
            "claimed {}",
            path.display()
        );
        assert_eq!(
            status_value(&registration, &fixture.data)["reasonCode"],
            "foreign_entry"
        );
    }
    let unknown_data = fixture.data.join("unavailable-data");
    assert!(may_replace(&fixture.registration(), &unknown_data).is_err());
    assert_eq!(
        status_value(&fixture.registration(), &unknown_data)["reasonCode"],
        "unreadable_entry"
    );
    assert!(!root.exists());
    assert!(!unknown_data.exists());
}

#[test]
fn unexpected_file_in_staging_hierarchy_is_never_owned() {
    let fixture = Fixture::new();
    fixture.remove_staging();
    let root = fixture.data.join("supervisor");
    fs::write(&root, b"another object's file").unwrap();
    assert!(may_replace(&fixture.registration(), &fixture.data).is_err());
    assert_eq!(
        status_value(&fixture.registration(), &fixture.data)["reasonCode"],
        "foreign_entry"
    );
    assert_eq!(fs::read(root).unwrap(), b"another object's file");
}

#[cfg(any(windows, unix))]
#[test]
fn dangling_links_in_staging_hierarchy_are_never_claimed_as_missing_owned_paths() {
    for at_root in [true, false] {
        let fixture = Fixture::new();
        fixture.remove_staging();
        let root = fixture.data.join("supervisor");
        let link = if at_root {
            root
        } else {
            fs::create_dir(&root).unwrap();
            fixture.executable.parent().unwrap().to_owned()
        };
        let missing_target = fixture
            ._temporary
            .path()
            .join("unavailable linked directory");
        directory_link(&missing_target, &link).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            status_value(&fixture.registration(), &fixture.data)["reasonCode"],
            "foreign_entry"
        );
        assert!(may_replace(&fixture.registration(), &fixture.data).is_err());
        let linked = fs::read_link(&link).unwrap();
        assert_eq!(dunce::simplified(&linked), missing_target);
    }
}

#[test]
fn another_program_data_directory_or_extra_argument_never_becomes_valid() {
    let fixture = Fixture::new();
    let mut foreign = fixture.args();
    foreign[0] = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let foreign = Registration::Command(foreign, None);
    assert_eq!(
        status_value(&foreign, &fixture.data)["reasonCode"],
        "foreign_entry"
    );
    assert!(may_replace(&foreign, &fixture.data).is_err());
    let mut wrong = fixture.args();
    wrong[2] = fixture._temporary.path().to_string_lossy().into_owned();
    assert_eq!(
        status_value(&Registration::Command(wrong, None), &fixture.data)["reasonCode"],
        "wrong_data"
    );
    let mut extra = fixture.args();
    extra.push("--unknown".into());
    assert_eq!(
        status_value(&Registration::Command(extra, None), &fixture.data)["enabled"],
        false
    );
}

#[test]
fn malformed_and_disabled_entries_are_never_reported_effective() {
    let fixture = Fixture::new();
    let invalid = status_value(&Registration::Invalid("invalid_entry"), &fixture.data);
    assert_eq!(invalid["configured"], true);
    assert_eq!(invalid["enabled"], false);
    assert!(may_replace(&Registration::Invalid("invalid_entry"), &fixture.data).is_err());
    let disabled = status_value(
        &Registration::Command(fixture.args(), Some("disabled_entry")),
        &fixture.data,
    );
    assert_eq!(disabled["reasonCode"], "disabled_entry");
    assert_eq!(disabled["healthy"], false);
}

#[test]
fn desktop_exec_roundtrips_spaces_unicode_and_two_escape_layers() {
    let executable = Path::new("/应用 目录/反\\斜线 $币 `符号` 100%/strata-supervisor");
    let data = Path::new("/模型 目录/含\"引号\"/数据");
    let command = desktop_command(executable, data).unwrap();
    assert!(command.contains("\\\\\\\\"));
    assert!(command.contains("\\\\$"));
    assert!(command.contains("100%%"));
    assert_eq!(
        desktop_arguments(&command).unwrap(),
        vec![
            executable.to_string_lossy().into_owned(),
            "--data-dir".into(),
            data.to_string_lossy().into_owned()
        ]
    );
    for invalid in [
        "/app --data-dir %U",
        "\"/app\" --data-dir \"$HOME\"",
        "\"/app\" --data-dir \"unterminated",
        "\"/app\" --data-dir \"data\" extra",
    ] {
        assert!(desktop_arguments(invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn desktop_entry_honors_disabling_and_rejects_duplicate_exec() {
    let fixture = Fixture::new();
    let exec = desktop_command(&fixture.executable, &fixture.data).unwrap();
    let normal = format!("[Desktop Entry]\nType=Application\nExec={exec}\nTerminal=false\n");
    assert_eq!(
        status_value(&desktop_registration(&normal), &fixture.data)["healthy"],
        true
    );
    let disabled = format!("{normal}Hidden=true\n");
    assert_eq!(
        status_value(&desktop_registration(&disabled), &fixture.data)["reasonCode"],
        "disabled_entry"
    );
    let restricted = format!("{normal}OnlyShowIn=GNOME;\n");
    assert_eq!(
        status_value(&desktop_registration(&restricted), &fixture.data)["reasonCode"],
        "restricted_entry"
    );
    let duplicate = format!("{normal}Exec=/other\n");
    assert_eq!(
        status_value(&desktop_registration(&duplicate), &fixture.data)["reasonCode"],
        "invalid_entry"
    );
}

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
}

#[cfg(windows)]
#[test]
fn windows_native_argument_parser_roundtrips_unicode_and_trailing_backslash() {
    let executable = Path::new(r"C:\应用 文件\strata-supervisor.exe");
    let data = Path::new(r"C:\模型 数据\");
    assert_eq!(
        platform::arguments(&command_line(executable, data)).unwrap(),
        vec![
            executable.to_string_lossy().into_owned(),
            "--data-dir".into(),
            data.to_string_lossy().into_owned()
        ]
    );
}

#[cfg(windows)]
#[test]
fn reading_missing_startup_status_does_not_create_a_registry_key() {
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND},
        System::Registry::{RegOpenKeyExW, HKEY_CURRENT_USER, KEY_QUERY_VALUE},
    };
    let directory = tempfile::tempdir().unwrap();
    let key = format!(
        "Software\\StrataManager\\Test-status-readonly-{}",
        uuid::Uuid::new_v4()
    );
    assert_eq!(
        platform::status_at(&key, directory.path()).unwrap()["configured"],
        false
    );
    let name: Vec<_> = key.encode_utf16().chain(Some(0)).collect();
    let mut handle = std::ptr::null_mut();
    let result = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            name.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut handle,
        )
    };
    assert!(
        result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND,
        "read created a registry key"
    );
}

#[cfg(windows)]
#[test]
fn registry_value_of_another_type_is_configured_but_never_enabled_or_replaced() {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{
            RegCloseKey, RegDeleteKeyW, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER,
            KEY_SET_VALUE, REG_DWORD,
        },
    };
    let fixture = Fixture::new();
    let key = format!(
        "Software\\StrataManager\\Test-status-type-{}",
        uuid::Uuid::new_v4()
    );
    platform::write(&key, platform::VALUE, Some("invalid")).unwrap();
    let name: Vec<_> = key.encode_utf16().chain(Some(0)).collect();
    let value: Vec<_> = platform::VALUE.encode_utf16().chain(Some(0)).collect();
    let mut handle = std::ptr::null_mut();
    unsafe {
        assert_eq!(
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                name.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut handle
            ),
            ERROR_SUCCESS
        );
        let number = 1u32.to_ne_bytes();
        assert_eq!(
            RegSetValueExW(
                handle,
                value.as_ptr(),
                0,
                REG_DWORD,
                number.as_ptr(),
                number.len() as u32
            ),
            ERROR_SUCCESS
        );
        RegCloseKey(handle);
    }
    let status = platform::status_at(&key, &fixture.data).unwrap();
    assert_eq!(status["configured"], true);
    assert_eq!(status["enabled"], false);
    assert_eq!(status["healthy"], false);
    assert_eq!(status["reasonCode"], "invalid_entry");
    assert!(platform::set_at(&key, true, &fixture.executable, &fixture.data).is_err());
    unsafe {
        assert_eq!(
            RegDeleteKeyW(HKEY_CURRENT_USER, name.as_ptr()),
            ERROR_SUCCESS
        );
    }
}

#[cfg(windows)]
#[test]
fn isolated_registry_can_disable_owned_entry_when_entire_staging_directory_is_missing() {
    use windows_sys::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let wide: Vec<_> = self.0.encode_utf16().chain(Some(0)).collect();
            unsafe {
                RegDeleteKeyW(HKEY_CURRENT_USER, wide.as_ptr());
            }
        }
    }
    let fixture = Fixture::new();
    let key = Cleanup(format!(
        "Software\\StrataManager\\Test-missing-stage-{}",
        uuid::Uuid::new_v4()
    ));
    platform::set_at(&key.0, true, &fixture.executable, &fixture.data).unwrap();
    fixture.remove_staging();
    let missing = platform::status_at(&key.0, &fixture.data).unwrap();
    assert_eq!(missing["configured"], true);
    assert_eq!(missing["reasonCode"], "missing_executable");
    let disabled = platform::set_at(&key.0, false, Path::new(""), &fixture.data).unwrap();
    assert_eq!(disabled["configured"], false);
    assert_eq!(disabled["enabled"], false);
    assert!(!fixture.data.join("supervisor").exists());
}

#[cfg(windows)]
#[test]
fn isolated_registry_status_reports_effective_command_and_preserves_unknown_entry() {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER},
    };
    let fixture = Fixture::new();
    let key = format!(
        "Software\\StrataManager\\Test-status-{}",
        uuid::Uuid::new_v4()
    );
    assert_eq!(
        platform::status_at(&key, &fixture.data).unwrap()["configured"],
        false
    );
    assert_eq!(
        platform::set_at(&key, true, &fixture.executable, &fixture.data).unwrap()["healthy"],
        true
    );
    fs::write(&fixture.executable, b"MZ corrupt staged fixture").unwrap();
    assert_eq!(
        platform::status_at(&key, &fixture.data).unwrap()["reasonCode"],
        "corrupt_executable"
    );
    assert_eq!(
        platform::set_at(&key, false, Path::new(""), &fixture.data).unwrap()["configured"],
        false
    );
    platform::write(
        &key,
        platform::VALUE,
        Some(&command_line(&fixture.executable, &fixture.data)),
    )
    .unwrap();
    fs::remove_file(&fixture.executable).unwrap();
    assert_eq!(
        platform::status_at(&key, &fixture.data).unwrap()["reasonCode"],
        "missing_executable"
    );
    let foreign = command_line(&std::env::current_exe().unwrap(), &fixture.data);
    platform::write(&key, platform::VALUE, Some(&foreign)).unwrap();
    assert_eq!(
        platform::status_at(&key, &fixture.data).unwrap()["enabled"],
        false
    );
    assert!(platform::set_at(&key, false, &fixture.executable, &fixture.data).is_err());
    assert_eq!(
        platform::status_at(&key, &fixture.data).unwrap()["reasonCode"],
        "foreign_entry"
    );
    platform::write(&key, platform::VALUE, None).unwrap();
    assert_eq!(
        platform::status_at(&key, &fixture.data).unwrap()["configured"],
        false
    );
    let wide: Vec<_> = key.encode_utf16().chain(Some(0)).collect();
    unsafe {
        assert_eq!(
            RegDeleteKeyW(HKEY_CURRENT_USER, wide.as_ptr()),
            ERROR_SUCCESS
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn isolated_xdg_entry_roundtrips_and_preserves_unknown_command() {
    let fixture = Fixture::new();
    let path = fixture
        ._temporary
        .path()
        .join("xdg-config/autostart/io.strata.manager.supervisor.desktop");
    assert_eq!(
        platform::status_at(&path, &fixture.data).unwrap()["configured"],
        false
    );
    assert_eq!(
        platform::set_at(&path, true, &fixture.executable, &fixture.data).unwrap()["healthy"],
        true
    );
    fs::write(&fixture.executable, b"\x7fELF corrupt staged fixture").unwrap();
    assert_eq!(
        platform::status_at(&path, &fixture.data).unwrap()["reasonCode"],
        "corrupt_executable"
    );
    platform::set_at(&path, false, Path::new(""), &fixture.data).unwrap();
    assert!(!path.exists());
    let own_command = desktop_command(&fixture.executable, &fixture.data).unwrap();
    fs::write(
        &path,
        format!("[Desktop Entry]\nType=Application\nExec={own_command}\n"),
    )
    .unwrap();
    fixture.remove_staging();
    assert_eq!(
        platform::status_at(&path, &fixture.data).unwrap()["reasonCode"],
        "missing_executable"
    );
    platform::set_at(&path, false, Path::new(""), &fixture.data).unwrap();
    assert!(!path.exists());
    assert!(!fixture.data.join("supervisor").exists());
    let unknown = "[Desktop Entry]\nType=Application\nExec=/usr/bin/other --data-dir /tmp\n";
    fs::write(&path, unknown).unwrap();
    assert_eq!(
        platform::status_at(&path, &fixture.data).unwrap()["enabled"],
        false
    );
    assert!(platform::set_at(&path, false, &fixture.executable, &fixture.data).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), unknown);
}
