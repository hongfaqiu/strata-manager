#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLanguage {
    locales: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installer_language: Option<String>,
}

/// Read-only preferences. The frontend applies them only when no language has
/// already been saved, so an update never overwrites a user's selection.
#[tauri::command]
pub fn get_system_language(app: tauri::AppHandle) -> SystemLanguage {
    SystemLanguage {
        locales: system_locales(),
        installer_language: installer_language_hint(&app),
    }
}

fn normalize_locale(value: &str) -> Option<String> {
    let tag = value.trim().split(['.', '@']).next()?.replace('_', "-");
    let parts: Vec<_> = tag.split('-').collect();
    if tag.len() > 85
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric()))
        || !parts.first()?.bytes().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    Some(tag)
}

#[cfg(any(not(windows), test))]
fn environment_locales(read: impl Fn(&str) -> Option<String>) -> Vec<String> {
    // The first nonempty override is authoritative, including C/POSIX or an
    // unsupported language. Do not silently turn C + LANG=zh_CN into Chinese.
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Some(value) = read(key).filter(|value| !value.trim().is_empty()) {
            return vec![normalize_locale(&value).unwrap_or_else(|| value.trim().to_string())];
        }
    }
    let mut locales = Vec::new();
    if let Some(language) = read("LANGUAGE") {
        for locale in language.split(':').filter_map(normalize_locale) {
            if !locales
                .iter()
                .any(|saved: &String| saved.eq_ignore_ascii_case(&locale))
            {
                locales.push(locale);
            }
        }
    }
    locales
}

#[cfg(any(windows, test))]
fn installer_language(value: &str) -> Option<&'static str> {
    match value.trim().parse::<u16>().ok()? {
        1033 => Some("en"),
        2052 => Some("zh-CN"),
        1028 => Some("zh-TW"),
        1041 => Some("ja"),
        1042 => Some("ko"),
        1031 => Some("de"),
        1036 => Some("fr"),
        1034 => Some("es"),
        2070 => Some("pt"),
        1049 => Some("ru"),
        _ => None,
    }
}

#[cfg(any(windows, test))]
fn installer_registry_key(identifier: &str, publisher: Option<&str>, product: &str) -> String {
    // Match Tauri's NSIS manufacturer fallback, instead of creating a second
    // preference key or depending on a hardcoded vendor name.
    let manufacturer =
        publisher.unwrap_or_else(|| identifier.split('.').nth(1).unwrap_or(identifier));
    format!("Software\\{manufacturer}\\{product}")
}

pub(crate) fn uses_english_fallback(language: Option<&str>) -> bool {
    language != Some("zh-CN")
}

#[cfg(windows)]
fn system_locales() -> Vec<String> {
    use windows_sys::Win32::Globalization::{
        GetUserDefaultLocaleName, GetUserPreferredUILanguages, MUI_LANGUAGE_NAME,
    };

    let mut language_count = 0;
    let mut length = 0;
    // Windows returns a UTF-16 multistring containing UI languages in order.
    let found = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut language_count,
            std::ptr::null_mut(),
            &mut length,
        )
    } != 0;
    if found && (1..=65536).contains(&length) {
        let mut buffer = vec![0_u16; length as usize];
        let found = unsafe {
            GetUserPreferredUILanguages(
                MUI_LANGUAGE_NAME,
                &mut language_count,
                buffer.as_mut_ptr(),
                &mut length,
            )
        } != 0;
        if found {
            let locales: Vec<_> = buffer
                .split(|character| *character == 0)
                .filter_map(|part| String::from_utf16(part).ok())
                .filter_map(|value| normalize_locale(&value))
                .collect();
            if !locales.is_empty() {
                return locales;
            }
        }
    }

    // Regional locale is a fallback when Windows cannot return UI preferences.
    // LOCALE_NAME_MAX_LENGTH in the Windows API is 85 UTF-16 characters.
    let mut buffer = [0_u16; 85];
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if length > 1 && length as usize <= buffer.len() {
        String::from_utf16(&buffer[..length as usize - 1])
            .ok()
            .and_then(|value| normalize_locale(&value))
            .into_iter()
            .collect()
    } else {
        Vec::new()
    }
}

#[cfg(not(windows))]
fn system_locales() -> Vec<String> {
    environment_locales(|key| std::env::var(key).ok())
}

#[cfg(windows)]
fn installer_language_hint(app: &tauri::AppHandle) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let config = app.config();
    let key = installer_registry_key(
        &config.identifier,
        config.bundle.publisher.as_deref(),
        config
            .product_name
            .as_deref()
            .unwrap_or(&app.package_info().name),
    );
    let key: Vec<_> = key.encode_utf16().chain(Some(0)).collect();
    let name: Vec<_> = "Installer Language".encode_utf16().chain(Some(0)).collect();
    // NSIS stores the numeric LANGID as a REG_SZ. Limit the buffer and accept
    // only bundled languages; malformed or missing registry values are ignored.
    let mut buffer = [0_u16; 16];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if result != 0 || bytes as usize > std::mem::size_of_val(&buffer) || !bytes.is_multiple_of(2) {
        return None;
    }
    let end = buffer.iter().position(|character| *character == 0)?;
    let value = String::from_utf16(&buffer[..end]).ok()?;
    installer_language(&value).map(str::to_string)
}

#[cfg(not(windows))]
fn installer_language_hint(_app: &tauri::AppHandle) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_reads_current_user_ui_preferences() {
        let locales = system_locales();
        eprintln!("Current Windows UI locales: {locales:?}");
        assert!(!locales.is_empty());
        assert!(locales
            .iter()
            .all(|locale| normalize_locale(locale).is_some()));
    }

    #[test]
    fn native_two_language_text_uses_english_for_new_packs_and_empty_settings() {
        assert!(!uses_english_fallback(Some("zh-CN")));
        for language in [
            None,
            Some("en"),
            Some("zh-TW"),
            Some("ja"),
            Some("ko"),
            Some("de"),
            Some("fr"),
            Some("es"),
            Some("pt"),
            Some("ru"),
        ] {
            assert!(uses_english_fallback(language), "{language:?}");
        }
    }

    #[test]
    fn normalizes_posix_locales_and_rejects_invalid_values() {
        assert_eq!(
            normalize_locale(" zh_TW.UTF-8@variant "),
            Some("zh-TW".into())
        );
        assert_eq!(normalize_locale("ja-JP"), Some("ja-JP".into()));
        assert_eq!(normalize_locale("C.UTF-8"), Some("C".into()));
        assert_eq!(normalize_locale("POSIX"), Some("POSIX".into()));
        for value in ["", " ", "___", "../../zh-CN", "ja\nJP"] {
            assert_eq!(normalize_locale(value), None, "{value:?}");
        }
    }

    #[test]
    fn highest_priority_message_locale_is_authoritative() {
        let values = [
            ("LC_ALL", "C.UTF-8"),
            ("LC_MESSAGES", "ja_JP.UTF-8"),
            ("LANG", "zh_CN.UTF-8"),
            ("LANGUAGE", "de:fr"),
        ];
        assert_eq!(
            environment_locales(|key| values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())),
            ["C"]
        );
        assert_eq!(
            environment_locales(|key| match key {
                "LC_MESSAGES" => Some("xx_XX.UTF-8".into()),
                "LANG" => Some("zh_CN.UTF-8".into()),
                _ => None,
            }),
            ["xx-XX"]
        );
        assert_eq!(
            environment_locales(|key| match key {
                "LC_ALL" => Some("not_a_locale?".into()),
                "LANG" => Some("zh_CN.UTF-8".into()),
                _ => None,
            }),
            ["not_a_locale?"]
        );
    }

    #[test]
    fn skips_empty_overrides_and_uses_language_list_only_without_primary() {
        assert_eq!(
            environment_locales(|key| match key {
                "LC_ALL" => Some(" ".into()),
                "LC_MESSAGES" => Some("pt_BR.UTF-8".into()),
                "LANG" => Some("zh_CN.UTF-8".into()),
                _ => None,
            }),
            ["pt-BR"]
        );
        assert_eq!(
            environment_locales(|key| (key == "LANGUAGE").then(|| "de:fr_FR.UTF-8:de".into())),
            ["de", "fr-FR"]
        );
        assert!(environment_locales(|_| None).is_empty());
    }

    #[test]
    fn installer_language_is_limited_to_available_packs() {
        for (id, language) in [
            ("1033", "en"),
            ("2052", "zh-CN"),
            ("1028", "zh-TW"),
            ("1041", "ja"),
            ("1042", "ko"),
            ("1031", "de"),
            ("1036", "fr"),
            ("1034", "es"),
            ("2070", "pt"),
            ("1049", "ru"),
        ] {
            assert_eq!(installer_language(id), Some(language));
        }
        for invalid in ["", "1040", "abc", "1033;echo test", "999999999"] {
            assert_eq!(installer_language(invalid), None);
        }
    }

    #[test]
    fn registry_key_matches_tauri_manufacturer_fallback() {
        assert_eq!(
            installer_registry_key("io.strata.manager", None, "Strata Manager"),
            "Software\\strata\\Strata Manager"
        );
        assert_eq!(
            installer_registry_key("io.strata.manager", Some("Example"), "Strata Manager"),
            "Software\\Example\\Strata Manager"
        );
    }
}
