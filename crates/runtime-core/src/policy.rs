use crate::{store, RuntimeState};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundPolicy {
    pub mode: String,
    pub auto_recover: bool,
    #[serde(default = "default_idle_minutes")]
    pub idle_unload_minutes: u16,
}
fn default_idle_minutes() -> u16 {
    15
}
impl Default for BackgroundPolicy {
    fn default() -> Self {
        Self {
            mode: "lazy".into(),
            auto_recover: true,
            idle_unload_minutes: default_idle_minutes(),
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
    let _operation = state
        .runtime_operations
        .try_lock()
        .map_err(|_| "后台正在启动或维护服务，请稍后修改运行策略")?;
    if !matches!(policy.mode.as_str(), "lazy" | "alwaysReady") {
        return Err("后台运行策略必须是 lazy 或 alwaysReady".into());
    }
    if policy.idle_unload_minutes > 1440 {
        return Err("空闲释放时间必须为 0–1440 分钟；0 表示关闭".into());
    }
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    let previous = store::get(&database, "backgroundPolicy")?;
    let previous = if previous.is_null() {
        Some(BackgroundPolicy::default())
    } else {
        serde_json::from_value::<BackgroundPolicy>(previous).ok()
    };
    let tx = database.transaction().map_err(|e| e.to_string())?;
    // Policy and idle history change atomically. Even a 60 -> 1 -> 60 ABA
    // invalidates the prior observation; a failed reset rolls back the policy.
    if previous.as_ref() != Some(&policy) {
        tx.execute("DELETE FROM kv WHERE key GLOB 'idleModelObservation:*'", [])
            .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO kv(key,value) VALUES('backgroundPolicy',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(&policy).map_err(|e| e.to_string())?],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
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
            ..BackgroundPolicy::default()
        };
        assert_eq!(set(&state, wanted.clone()).unwrap(), wanted);
        assert!(set(
            &state,
            BackgroundPolicy {
                mode: "unlimited".into(),
                auto_recover: true,
                ..BackgroundPolicy::default()
            }
        )
        .is_err());
        drop(state);
        let restored = RuntimeState::open(temp.path().into()).unwrap();
        assert_eq!(get(&restored).unwrap(), wanted);
    }
    #[test]
    fn legacy_policy_defaults_to_fifteen_minutes_and_invalid_idle_period_is_not_saved() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        crate::store_set(
            &state,
            "backgroundPolicy".into(),
            serde_json::json!({"mode":"lazy","autoRecover":true}),
        )
        .unwrap();
        assert_eq!(get(&state).unwrap().idle_unload_minutes, 15);
        let disabled = BackgroundPolicy {
            idle_unload_minutes: 0,
            ..BackgroundPolicy::default()
        };
        set(&state, disabled.clone()).unwrap();
        assert!(set(
            &state,
            BackgroundPolicy {
                idle_unload_minutes: 1441,
                ..BackgroundPolicy::default()
            }
        )
        .is_err());
        assert_eq!(get(&state).unwrap(), disabled);
        assert!(serde_json::from_value::<BackgroundPolicy>(
            serde_json::json!({"mode":"lazy","autoRecover":true,"idleUnloadMinutes":-1})
        )
        .is_err());
    }
    #[test]
    fn policy_change_and_idle_history_reset_are_atomic_and_aba_invalidates_history() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        let original = BackgroundPolicy {
            idle_unload_minutes: 60,
            ..BackgroundPolicy::default()
        };
        set(&state, original.clone()).unwrap();
        crate::store_set(
            &state,
            "idleModelObservation:fixture".into(),
            serde_json::json!({"sentinel":"old idle"}),
        )
        .unwrap();
        state.database.lock().unwrap().execute_batch("CREATE TRIGGER fail_idle_reset BEFORE DELETE ON kv WHEN OLD.key GLOB 'idleModelObservation:*' BEGIN SELECT RAISE(ABORT,'fixture reset failure'); END;").unwrap();
        let shorter = BackgroundPolicy {
            idle_unload_minutes: 1,
            ..original.clone()
        };
        assert!(set(&state, shorter.clone()).is_err());
        assert_eq!(get(&state).unwrap(), original);
        assert!(
            !crate::store_get(&state, "idleModelObservation:fixture".into())
                .unwrap()
                .is_null()
        );
        state
            .database
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_idle_reset;")
            .unwrap();
        set(&state, shorter).unwrap();
        set(&state, original.clone()).unwrap();
        assert_eq!(get(&state).unwrap(), original);
        assert!(
            crate::store_get(&state, "idleModelObservation:fixture".into())
                .unwrap()
                .is_null()
        );
    }
}
