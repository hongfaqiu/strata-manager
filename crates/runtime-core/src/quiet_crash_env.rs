//! Child-only `GGML_NO_BACKTRACE=1`, matching upstream 38ad0bc `quiet_crash_env`.
//!
//! ggml's abort path may fork gdb/lldb and write debugger errors into the engine log
//! and the picture reader's READY pipe. The product sets `GGML_NO_BACKTRACE=1` on
//! every child it starts, unless that variable is already present or a developer
//! asked for the backtrace with `STRATA_BACKTRACE` (anything but empty / 0 / no /
//! off / false). This module never writes the current process environment.

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    process::Command,
};

pub const GGML_NO_BACKTRACE: &str = "GGML_NO_BACKTRACE";
pub const STRATA_BACKTRACE: &str = "STRATA_BACKTRACE";

/// True when `STRATA_BACKTRACE` is set to anything but empty / 0 / no / off / false.
pub fn developer_wants_backtrace(value: Option<&str>) -> bool {
    let value = value.unwrap_or("").trim();
    if value.is_empty() {
        return false;
    }
    !matches!(
        value.to_ascii_lowercase().as_str(),
        "0" | "no" | "off" | "false"
    )
}

/// Whether the child should receive `GGML_NO_BACKTRACE=1`.
///
/// `child` is a variable already assigned to the child (`None` if unset or
/// explicitly removed). `inherited` is the same name in the current process
/// environment. An existing `GGML_NO_BACKTRACE` in either place is left alone.
/// The developer switch is honoured if either place turns it on, as upstream
/// checks both the child dict and `os.environ`.
pub fn should_set(
    child_no_backtrace: Option<&str>,
    inherited_no_backtrace: Option<&str>,
    child_switch: Option<&str>,
    inherited_switch: Option<&str>,
) -> bool {
    if child_no_backtrace.is_some() || inherited_no_backtrace.is_some() {
        return false;
    }
    if developer_wants_backtrace(child_switch) || developer_wants_backtrace(inherited_switch) {
        return false;
    }
    true
}

/// Insert `GGML_NO_BACKTRACE=1` into a child env plan when `should_set` says so.
/// `inherited` is the parent process lookup already used by `LauncherEnv::env_plan`.
pub fn apply_to_plan(
    plan: &mut BTreeMap<String, Option<String>>,
    inherited: &dyn Fn(&str) -> Option<String>,
) {
    let planned = |key: &str| plan.get(key).cloned().flatten();
    if should_set(
        planned(GGML_NO_BACKTRACE).as_deref(),
        if plan.contains_key(GGML_NO_BACKTRACE) {
            None
        } else {
            inherited(GGML_NO_BACKTRACE)
        }
        .as_deref(),
        planned(STRATA_BACKTRACE).as_deref(),
        inherited(STRATA_BACKTRACE).as_deref(),
    ) {
        plan.insert(GGML_NO_BACKTRACE.to_string(), Some("1".into()));
    }
}

/// Set `GGML_NO_BACKTRACE=1` on a child `Command` only. Never writes `std::env`.
pub fn apply_to_command(command: &mut Command) {
    let overrides: Vec<(OsString, Option<OsString>)> = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
        .collect();
    let child = |key: &str| -> Option<Option<String>> {
        overrides.iter().find_map(|(name, value)| {
            same_var(name, key).then(|| value.as_ref().map(|v| v.to_string_lossy().into_owned()))
        })
    };
    let child_no = match child(GGML_NO_BACKTRACE) {
        Some(Some(value)) => Some(value),
        Some(None) => None,
        None => None,
    };
    let inherited_no = match child(GGML_NO_BACKTRACE) {
        Some(_) => None,
        None => std::env::var(GGML_NO_BACKTRACE).ok(),
    };
    let child_switch = match child(STRATA_BACKTRACE) {
        Some(Some(value)) => Some(value),
        Some(None) => None,
        None => None,
    };
    let inherited_switch = std::env::var(STRATA_BACKTRACE).ok();
    if should_set(
        child_no.as_deref(),
        inherited_no.as_deref(),
        child_switch.as_deref(),
        inherited_switch.as_deref(),
    ) {
        command.env(GGML_NO_BACKTRACE, "1");
    }
}

fn same_var(name: &OsStr, key: &str) -> bool {
    if cfg!(windows) {
        name.to_string_lossy().eq_ignore_ascii_case(key)
    } else {
        name == OsStr::new(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(
        no: Option<&str>,
        inherited_no: Option<&str>,
        sw: Option<&str>,
        inherited_sw: Option<&str>,
    ) -> bool {
        should_set(no, inherited_no, sw, inherited_sw)
    }

    #[test]
    fn default_sets_the_variable() {
        assert!(set(None, None, None, None));
    }

    #[test]
    fn existing_child_value_is_left_alone() {
        assert!(!set(Some("1"), None, None, None));
        assert!(!set(Some("0"), None, None, None));
        assert!(!set(Some(""), None, None, None));
    }

    #[test]
    fn inherited_value_is_left_alone() {
        assert!(!set(None, Some("1"), None, None));
        assert!(!set(None, Some("0"), None, None));
    }

    #[test]
    fn developer_switch_in_the_child_skips() {
        for value in ["1", "yes", "true", "on", "TRUE", " Yes "] {
            assert!(!set(None, None, Some(value), None), "{value}");
        }
    }

    #[test]
    fn developer_switch_in_the_process_skips() {
        assert!(!set(None, None, None, Some("1")));
        assert!(!set(None, None, Some("0"), Some("yes")));
    }

    #[test]
    fn off_switch_values_still_set() {
        for value in ["", "0", "no", "off", "false", "NO", " Off "] {
            assert!(set(None, None, Some(value), None), "{value}");
            assert!(set(None, None, None, Some(value)), "{value}");
        }
        assert!(set(None, None, Some("0"), Some("false")));
    }

    #[test]
    fn apply_to_plan_sets_by_default_and_does_not_overwrite() {
        let inherited = |_: &str| None;
        let mut plan = BTreeMap::new();
        apply_to_plan(&mut plan, &inherited);
        assert_eq!(
            plan.get(GGML_NO_BACKTRACE).cloned().flatten().as_deref(),
            Some("1")
        );

        let mut kept = BTreeMap::from([(GGML_NO_BACKTRACE.to_string(), Some("keep".into()))]);
        apply_to_plan(&mut kept, &inherited);
        assert_eq!(
            kept.get(GGML_NO_BACKTRACE).cloned().flatten().as_deref(),
            Some("keep")
        );

        let mut switched = BTreeMap::from([(STRATA_BACKTRACE.to_string(), Some("1".into()))]);
        apply_to_plan(&mut switched, &inherited);
        assert!(!switched.contains_key(GGML_NO_BACKTRACE));

        let inherit_existing = |key: &str| (key == GGML_NO_BACKTRACE).then(|| "from-parent".into());
        let mut from_parent = BTreeMap::new();
        apply_to_plan(&mut from_parent, &inherit_existing);
        assert!(!from_parent.contains_key(GGML_NO_BACKTRACE));
    }

    #[test]
    fn apply_to_plan_does_not_write_process_environment() {
        let before_no = std::env::var_os(GGML_NO_BACKTRACE);
        let before_sw = std::env::var_os(STRATA_BACKTRACE);
        let inherited = |_: &str| None;
        let mut plan = BTreeMap::new();
        apply_to_plan(&mut plan, &inherited);
        assert_eq!(std::env::var_os(GGML_NO_BACKTRACE), before_no);
        assert_eq!(std::env::var_os(STRATA_BACKTRACE), before_sw);
    }
}
