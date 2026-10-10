use crate::{store, RuntimeState};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundPolicy {
    pub mode: String,
    pub auto_recover: bool,
}
impl Default for BackgroundPolicy {
    fn default() -> Self {
        Self {
            mode: "lazy".into(),
            auto_recover: true,
        }
    }
}
pub fn get(state: &RuntimeState) -> Result<BackgroundPolicy, String> {
    let database = state.database.lock().map_err(|e| e.to_string())?;
    let value = store::get(&database, "backgroundPolicy")?;
    if value.is_null() {
        Ok(BackgroundPolicy::default())
    } else {
        serde_json::from_value(value).map_err(|e| format!("后台策略无法读取: {e}"))
    }
}
pub fn set(state: &RuntimeState, policy: BackgroundPolicy) -> Result<BackgroundPolicy, String> {
    if !matches!(policy.mode.as_str(), "lazy" | "alwaysReady") {
        return Err("后台运行策略必须是 lazy 或 alwaysReady".into());
    }
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    store::set(
        &mut database,
        "backgroundPolicy",
        serde_json::to_value(&policy).map_err(|e| e.to_string())?,
    )?;
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_policy_is_lightweight_and_invalid_mode_never_changes_saved_policy() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        assert_eq!(get(&state).unwrap(), BackgroundPolicy::default());
        let wanted = BackgroundPolicy {
            mode: "alwaysReady".into(),
            auto_recover: false,
        };
        assert_eq!(set(&state, wanted.clone()).unwrap(), wanted);
        assert!(set(
            &state,
            BackgroundPolicy {
                mode: "unlimited".into(),
                auto_recover: true
            }
        )
        .is_err());
        drop(state);
        let restored = RuntimeState::open(temp.path().into()).unwrap();
        assert_eq!(get(&restored).unwrap(), wanted);
    }
}
