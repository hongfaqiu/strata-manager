//! Read-only evidence from the exact owned native engine command. Saved args
//! cannot establish a running prompt-cache depth after an unapplied config edit.
use crate::{storage, types::ServiceProfile, RuntimeState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn prompt_cache(args: &[String]) -> Result<Option<u64>, String> {
    let mut found = None;
    for (index, arg) in args.iter().enumerate() {
        let value = if arg == "--prompt-cache" {
            Some(
                args.get(index + 1)
                    .map(String::as_str)
                    .ok_or("实际 --prompt-cache 缺少值")?,
            )
        } else {
            arg.strip_prefix("--prompt-cache=")
        };
        if let Some(value) = value {
            if found.is_some() {
                return Err("实际 --prompt-cache 重复，缓存深度无法核验".into());
            }
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err("实际 --prompt-cache 不是非负整数".into());
            }
            let value = value
                .parse::<u64>()
                .map_err(|_| "实际 --prompt-cache 超出可核验范围")?;
            if value > 9_007_199_254_740_991 {
                return Err("实际 --prompt-cache 超出可核验范围".into());
            }
            found = Some(value);
        }
    }
    Ok(found)
}

fn root_identity(state: &RuntimeState, profile: &ServiceProfile) -> Result<(u32, u64), String> {
    let current = state.owned_gui_profile(&profile.id)?;
    if serde_json::to_value(&current).map_err(|e| e.to_string())?
        != serde_json::to_value(profile).map_err(|e| e.to_string())?
    {
        return Err("运行中安装登记已改变，未确认缓存深度".into());
    }
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let process = processes
        .get_mut(&profile.id)
        .ok_or("运行中进程归属不可核验")?;
    let status = process.refresh()?;
    if !status.running || !status.owned || status.pid != Some(process.child.id()) {
        return Err("运行中进程归属不可核验".into());
    }
    Ok((
        process.child.id(),
        status.started_at.ok_or("运行中根进程创建时间不可核验")?,
    ))
}

fn executable(config: &Value, profile: &ServiceProfile) -> Result<PathBuf, String> {
    let cwd = config
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&profile.install_dir));
    let exe = Path::new(
        config["exe"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("运行配置未提供引擎路径")?,
    );
    dunce::canonicalize(if exe.is_absolute() {
        exe.to_path_buf()
    } else {
        cwd.join(exe)
    })
    .map_err(|_| "引擎文件身份不可核验".into())
}

fn snapshot() -> sysinfo::System {
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::Always),
    );
    system
}
fn command(process: &sysinfo::Process) -> Result<Vec<String>, String> {
    process
        .cmd()
        .iter()
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or_else(|| "实际引擎参数包含不可核验的 Unicode".into())
        })
        .collect()
}

fn verified_evidence(state: &RuntimeState, profile_id: &str) -> Result<Value, String> {
    let profile = state.owned_gui_profile(profile_id)?;
    let root = root_identity(state, &profile)?;
    // The file identifies the executable only. Its args are deliberately unused.
    let exe = executable(&storage::read(&profile)?, &profile)?;
    let system = snapshot();
    let mut matches = Vec::new();
    for (pid, process) in system.processes() {
        if pid.as_u32() == root.0
            || process
                .exe()
                .and_then(|path| dunce::canonicalize(path).ok())
                .as_ref()
                != Some(&exe)
        {
            continue;
        }
        let owned = state
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .get(&profile.id)
            .ok_or("运行中进程树已改变")?
            .owns_pid(pid.as_u32())?;
        if owned {
            matches.push((pid.as_u32(), process.start_time(), command(process)?));
        }
    }
    if matches.len() != 1 {
        return Err(if matches.is_empty() {
            "没有找到身份匹配的受管原生引擎进程"
        } else {
            "多个受管原生引擎匹配，缓存深度无法唯一核验"
        }
        .into());
    }
    let (pid, started, args) = matches.pop().unwrap();
    let depth = prompt_cache(&args)?.ok_or("实际引擎命令没有明确 --prompt-cache；默认深度未知")?;
    if started == 0 {
        return Err("原生引擎创建时间不可核验".into());
    }
    let after = snapshot();
    let native = after
        .process(sysinfo::Pid::from_u32(pid))
        .ok_or("原生引擎已退出，缓存深度未确认")?;
    if native.start_time() != started
        || native
            .exe()
            .and_then(|path| dunce::canonicalize(path).ok())
            .as_ref()
            != Some(&exe)
        || prompt_cache(&command(native)?)? != Some(depth)
    {
        return Err("原生引擎身份或参数在读取期间已改变".into());
    }
    if root_identity(state, &profile)? != root {
        return Err("根进程在读取期间已改变，缓存深度未确认".into());
    }
    if !state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get(&profile.id)
        .ok_or("运行中进程树已改变")?
        .owns_pid(pid)?
    {
        return Err("原生引擎已离开受管进程树".into());
    }
    Ok(
        json!({"verified":true,"promptCache":depth,"pid":pid,"startedAt":started.saturating_mul(1000)}),
    )
}

/// Does not start/load a model, issue inference, or read saved prompt-cache args.
/// Unsupported or unverifiable installations have an explicit reason and no
/// invented default; callers can keep the prefix option disabled.
pub fn evidence(state: &RuntimeState, profile_id: &str) -> Result<Value, String> {
    Ok(match verified_evidence(state, profile_id) {
        Ok(value) => value,
        Err(reason) => {
            json!({"verified":false,"promptCache":null,"pid":null,"startedAt":null,"reason":reason})
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }
    #[test]
    fn actual_argv_accepts_two_spellings_and_never_invents_defaults() {
        assert_eq!(
            prompt_cache(&args(&["strata", "--prompt-cache", "4"])).unwrap(),
            Some(4)
        );
        assert_eq!(
            prompt_cache(&args(&["strata", "--prompt-cache=0"])).unwrap(),
            Some(0)
        );
        assert_eq!(
            prompt_cache(&args(&["strata", "--prompt-cache-other=99"])).unwrap(),
            None
        );
        assert_eq!(prompt_cache(&[]).unwrap(), None);
        for values in [
            &["--prompt-cache"][..],
            &["--prompt-cache", "--other"],
            &["--prompt-cache=-1"],
            &["--prompt-cache=1.5"],
            &["--prompt-cache="],
            &["--prompt-cache=3", "--prompt-cache", "4"],
            &["--prompt-cache=9007199254740992"],
        ] {
            assert!(prompt_cache(&args(values)).is_err(), "{values:?}");
        }
    }
    #[test]
    fn unowned_service_returns_unknown_evidence_without_starting_a_process() {
        let directory = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(directory.path().into()).unwrap();
        let value = evidence(&state, "missing").unwrap();
        assert_eq!(value["verified"], false);
        assert!(value["reason"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(value["promptCache"].is_null());
        assert!(state.processes.lock().unwrap().is_empty());
    }
    #[test]
    fn isolated_owned_child_uses_live_argv_and_missing_flag_remains_unknown() {
        use std::{
            fs,
            process::Command,
            time::{Duration, Instant},
        };
        let mut locate = Command::new(if cfg!(windows) { "py" } else { "python3" });
        locate.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
        crate::processes::hidden(&mut locate);
        let output = locate
            .output()
            .expect("isolated command fixture requires Python");
        assert!(output.status.success());
        let python = String::from_utf8(output.stdout).unwrap().trim().to_owned();
        for explicit in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let state = RuntimeState::open(directory.path().join("private-data")).unwrap();
            struct Cleanup(std::sync::Arc<RuntimeState>);
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    self.0.cleanup();
                }
            }
            let _cleanup = Cleanup(state.clone());
            let marker = directory.path().join("native-pid.txt");
            let profile = ServiceProfile {
                id: format!("argv-{}", uuid::Uuid::new_v4()),
                name: "CPU argv fixture".into(),
                base_url: "http://127.0.0.1:8099".into(),
                install_dir: directory.path().to_string_lossy().into(),
                python_path: python.clone(),
                config_path: directory
                    .path()
                    .join("fixture.json")
                    .to_string_lossy()
                    .into(),
                managed: true,
            };
            // Saved config intentionally disagrees with the child's actual argv.
            fs::write(
                &profile.config_path,
                serde_json::to_vec(
                    &json!({"exe":python,"cwd":directory.path(),"args":["--prompt-cache","99"]}),
                )
                .unwrap(),
            )
            .unwrap();
            state
                .database
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
                    rusqlite::params![
                        profile.id,
                        serde_json::to_string(&profile).unwrap(),
                        serde_json::to_string(&profile).unwrap(),
                        crate::now() as i64
                    ],
                )
                .unwrap();
            let script="import subprocess,sys,time;from pathlib import Path;child=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(15)']+(['--prompt-cache=4'] if sys.argv[2]=='1' else []));Path(sys.argv[1]).write_text(str(child.pid));time.sleep(15)";
            let mut command = Command::new(&python);
            command
                .args(["-I", "-S", "-c", script])
                .arg(&marker)
                .arg(if explicit { "1" } else { "0" });
            let mut process =
                crate::processes::OwnedProcess::spawn(command, state.logs.clone(), &profile.id)
                    .unwrap();
            process.profile = Some(profile.clone());
            state
                .processes
                .lock()
                .unwrap()
                .insert(profile.id.clone(), process);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !marker.exists() {
                assert!(Instant::now() < deadline, "child marker missing");
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid = fs::read_to_string(marker).unwrap().parse::<u32>().unwrap();
            let value = evidence(&state, &profile.id).unwrap();
            assert_eq!(value["verified"], explicit, "{value}");
            if explicit {
                assert_eq!(value["promptCache"], 4);
                assert_eq!(value["pid"], pid);
                assert!(value["startedAt"].as_u64().is_some_and(|n| n > 0));
                let mut config = storage::read(&profile).unwrap();
                config["args"] = json!(["--prompt-cache", "0"]);
                fs::write(&profile.config_path, serde_json::to_vec(&config).unwrap()).unwrap();
                assert_eq!(evidence(&state, &profile.id).unwrap()["promptCache"], 4);
                config["exe"] = json!(std::env::current_exe().unwrap());
                fs::write(&profile.config_path, serde_json::to_vec(&config).unwrap()).unwrap();
                assert_eq!(
                    evidence(&state, &profile.id).unwrap()["verified"],
                    false,
                    "another executable identity must not establish support"
                );
            } else {
                assert!(value["promptCache"].is_null());
                assert!(value["reason"].as_str().unwrap().contains("默认深度未知"));
            }
        }
    }
}
