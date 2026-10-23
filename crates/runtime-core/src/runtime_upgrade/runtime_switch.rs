//! Moving saved configurations from one installed runtime directory to another.
//!
//! Used when an update changes Python dependencies (a new independent runtime
//! is prepared next to the old one) and by 「切换到此版本」 in the installed
//! versions list. The source runtime is never modified: every configuration
//! gets a migrated copy in the Manager's data folder, and the primary one goes
//! through the reviewed drain → stop → start → verify switch, which restores
//! the previous runtime and its load state on any failure.
use super::*;

/// Manager-owned folder for migrated configuration copies, one subfolder per task.
const CONFIG_DIR: &str = "runtime-configs";

pub(super) struct SwitchTarget {
    pub root: PathBuf,
    pub python: String,
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.into()
    }
}

fn read_build(engine: &Path) -> Result<Value, String> {
    let path = engine.join("BUILD.json");
    let size = fs::metadata(&path)
        .map_err(|_| format!("目标运行环境的引擎缺少 BUILD.json：{}", engine.display()))?
        .len();
    if size > 65536 {
        return Err("目标引擎版本文件超过上限".into());
    }
    serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|_| "目标引擎 BUILD.json 无效".into())
}

/// The engine folder of `target` mirroring the one the configuration uses in `source`.
pub(super) fn target_engine(source: &Path, exe: &Path, target: &Path) -> Result<PathBuf, String> {
    let parent = exe.parent().ok_or("配置的引擎路径没有父目录")?;
    let parent =
        dunce::canonicalize(parent).map_err(|_| "配置的引擎目录不存在，无法确定对应引擎")?;
    let relative = parent.strip_prefix(source).map_err(|_| {
        format!(
            "此配置使用运行环境之外的引擎（{}），切换版本不会替换它；请先改用运行环境自带的引擎",
            parent.display()
        )
    })?;
    if relative.as_os_str().is_empty() {
        return Err("引擎与源码共用根目录，无法确定目标引擎目录".into());
    }
    let mut engine = target.join(relative);
    if !engine.join(exe_name("strata")).is_file() {
        // Official packages may name the folder differently from a source build.
        if let Some(found) = crate::discovery::known_engine_dir_names()
            .iter()
            .map(|name| target.join(name))
            .find(|dir| dir.join(exe_name("strata")).is_file() && dir.join("BUILD.json").is_file())
        {
            engine = found;
        }
    }
    if !engine.join(exe_name("strata")).is_file() {
        return Err(format!(
            "目标运行环境缺少对应的引擎 {}；未停止服务",
            relative.display()
        ));
    }
    let engine = dunce::canonicalize(engine).map_err(|e| e.to_string())?;
    if !engine.starts_with(target) {
        return Err("目标引擎路径被重定向，未切换".into());
    }
    Ok(engine)
}

/// Whether a string names an existing path relative to `cwd`: a separator or a
/// file extension, so plain words and numbers in engine arguments never match.
fn relative_path_argument(cwd: &Path, value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.starts_with('-') || Path::new(value).is_absolute() {
        return None;
    }
    let looks_like_path =
        value.contains(['/', '\\']) || Path::new(value).extension().is_some_and(|e| e.len() <= 12);
    if !looks_like_path || value.parse::<f64>().is_ok() {
        return None;
    }
    let path = cwd.join(value);
    path.exists().then_some(path)
}

/// Library folders for `engine`: its own folder and BUILD.json `lib_dirs`, else
/// BUILD.json `cuda_dirs`, else pip's NVIDIA wheels in the target's private
/// Python. Absolute folders outside the source runtime (a system toolkit) stay.
pub(super) fn target_libs(
    source: &Path,
    target: &Path,
    engine: &Path,
    build: &Value,
    previous: &[Value],
) -> Result<Vec<String>, String> {
    if build["backend"] == "hip" {
        return hip_dirs(engine, build);
    }
    let mut dirs: Vec<String> = Vec::new();
    let push = |path: &Path, dirs: &mut Vec<String>| {
        let value = path.to_string_lossy().into_owned();
        if !dirs.contains(&value) {
            dirs.push(value);
        }
    };
    let own = release_zip::engine_trial::library_dirs(engine);
    if own.len() > 1 {
        for dir in &own {
            push(dir, &mut dirs);
        }
    } else if let Some(cuda) = build["cuda_dirs"].as_array().filter(|d| !d.is_empty()) {
        for dir in cuda.iter().filter_map(Value::as_str).map(Path::new) {
            if dir.is_absolute() && dir.is_dir() {
                push(dir, &mut dirs);
            }
        }
    } else {
        let major = build["cuda"]
            .as_str()
            .and_then(|v| v.split('.').next())
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(13);
        if target.join(".venv/Lib/site-packages/nvidia").is_dir() {
            if let Ok(found) = cuda_dirs(target, major) {
                dirs.extend(found);
            }
        }
        if dirs.is_empty() {
            push(engine, &mut dirs);
        }
    }
    for dir in previous.iter().filter_map(Value::as_str).map(Path::new) {
        let outside = dunce::canonicalize(dir).is_ok_and(|p| !p.starts_with(source));
        if dir.is_absolute() && dir.is_dir() && outside {
            push(dir, &mut dirs);
        }
    }
    Ok(dirs)
}

/// The configuration rewritten for `target`; the original file is never changed.
/// Paths that pointed into `source` keep pointing at the same files, except the
/// engine (and vision encoder) of the target and a relative log, which moves.
pub(super) fn migrate(
    profile: &ServiceProfile,
    config: &Value,
    source: &Path,
    target: &Path,
) -> Result<Value, String> {
    validate_hooks(profile, config)?;
    let cwd = config_cwd(profile, config)?;
    let runtime = Path::new(&profile.install_dir);
    let exe = resolve(&cwd, config["exe"].as_str().ok_or("配置缺少 exe")?);
    let engine = target_engine(source, &exe, target)?;
    let build = read_build(&engine)?;
    if let Some(old) = exe.parent().and_then(release_zip::directory_variant) {
        let new = release_zip::directory_variant(&engine).ok_or("目标引擎类型无法识别，未切换")?;
        if !release_zip::variant_compatible(old, new) {
            return Err(format!(
                "目标运行环境的引擎类型（{new}）与此配置使用的（{old}）不同，未切换"
            ));
        }
    }
    let mut out = config.clone();
    let obj = out.as_object_mut().ok_or("配置不是对象")?;
    // A configuration started from its runtime folder starts from the target folder.
    // Relative path arguments become absolute so they still name the same files.
    let moves_cwd = cwd == source;
    let new_cwd = if moves_cwd {
        target.to_path_buf()
    } else {
        cwd.clone()
    };
    if moves_cwd {
        if let Some(args) = obj.get_mut("args").and_then(Value::as_array_mut) {
            for arg in args.iter_mut() {
                if let Some(path) = arg.as_str().and_then(|v| relative_path_argument(&cwd, v)) {
                    *arg = json!(path);
                }
            }
        }
    }
    obj.insert("cwd".into(), json!(new_cwd));
    obj.insert("exe".into(), json!(engine.join(exe_name("strata"))));
    let previous = config["lib_dirs"].as_array().cloned().unwrap_or_default();
    obj.insert(
        "lib_dirs".into(),
        json!(target_libs(source, target, &engine, &build, &previous)?),
    );
    // The official server resolves tokenizer relative to its own runtime folder.
    let tokenizer = config["tokenizer"]
        .as_str()
        .ok_or("配置没有 tokenizer，无法证明默认 tokenizer 在目标运行环境相同；请填写现有目录")?;
    let tokenizer = resolve(runtime, tokenizer);
    if !tokenizer.join("vocab.json").is_file() {
        return Err("原 tokenizer 缺少 vocab.json；未下载替代资源".into());
    }
    obj.insert(
        "tokenizer".into(),
        json!(dunce::canonicalize(tokenizer).map_err(|e| e.to_string())?),
    );
    if let Some(raw) = config["log"].as_str().filter(|v| !v.is_empty()) {
        let log = if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            target.join(raw)
        };
        obj.insert("log".into(), json!(log));
    }
    for key in ["expert_profile_save", "slot_save_path"] {
        if let Some(raw) = config[key].as_str().filter(|v| !v.is_empty()) {
            obj.insert(key.into(), json!(resolve(&cwd, raw)));
        }
    }
    if let Some(vision) = obj.get_mut("vision").and_then(Value::as_object_mut) {
        for key in ["model", "mmproj"] {
            if let Some(raw) = vision.get(key).and_then(Value::as_str) {
                let path = resolve(&cwd, raw);
                if !path.is_file() {
                    return Err(format!("vision.{key} 资源不存在；保持原运行环境"));
                }
                vision.insert(key.into(), json!(path));
            }
        }
        let exe = engine.join(exe_name("strata-vision"));
        if !exe.is_file() {
            return Err("目标引擎缺少当前配置所需的视觉编码器，未停服务".into());
        }
        vision.insert("exe".into(), json!(exe));
    }
    for key in ["mcp_servers", "mcpServers"] {
        if let Some(servers) = obj.get_mut(key).and_then(Value::as_object_mut) {
            for server in servers.values_mut() {
                if server
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.is_empty())
                {
                    continue;
                }
                let cfg = server.as_object_mut().ok_or("MCP 配置无效")?;
                let cwd = resolve(
                    runtime,
                    cfg.get("cwd")
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                        .unwrap_or("."),
                );
                if let Some(command) = cfg
                    .get("command")
                    .and_then(Value::as_str)
                    .filter(|v| v.contains(['/', '\\']))
                {
                    cfg.insert("command".into(), json!(resolve(&cwd, command)));
                }
                cfg.insert(
                    "cwd".into(),
                    json!(dunce::canonicalize(cwd).map_err(|_| "MCP cwd 无法核验")?),
                );
            }
        }
    }
    storage::validate(&out)?;
    Ok(out)
}

struct Prepared {
    old: ServiceProfile,
    candidate: ServiceProfile,
    old_sha256: String,
    candidate_sha256: String,
}

fn prepare(
    state: &RuntimeState,
    task_id: &str,
    profile: &ServiceProfile,
    source: &Path,
    target: &SwitchTarget,
) -> Result<Prepared, String> {
    let config_path = storage::config_path(profile)?;
    let old_sha256 = installation::file_hash(&config_path)?;
    let config = storage::read(profile)?;
    storage::validate(&config)?;
    let migrated = migrate(profile, &config, source, &target.root)
        .map_err(|e| format!("配置「{}」无法迁移：{e}", profile.name))?;
    let folder = installation::owned_directory(state.data_dir(), &[CONFIG_DIR, task_id])?;
    let file = config_path.file_name().ok_or("配置文件名为空")?;
    let mut candidate = profile.clone();
    candidate.install_dir = target.root.to_string_lossy().into();
    candidate.python_path = target.python.clone();
    candidate.config_path = folder.join(file).to_string_lossy().into();
    atomic_new(
        Path::new(&candidate.config_path),
        &serde_json::to_vec_pretty(&migrated).map_err(|e| e.to_string())?,
    )?;
    copy_shared_settings(profile, &candidate)?;
    let candidate_sha256 = installation::file_hash(Path::new(&candidate.config_path))?;
    Ok(Prepared {
        old: profile.clone(),
        candidate,
        old_sha256,
        candidate_sha256,
    })
}

fn running_owned(state: &RuntimeState, id: &str) -> Result<bool, String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    Ok(processes
        .get_mut(id)
        .map(|p| p.refresh())
        .transpose()?
        .is_some_and(|s| s.running && s.owned))
}

/// The configuration that goes through the full verified switch: the running
/// one, else the selected one, else the first.
fn primary_index(running: &[bool], ids: &[&str], active: Option<&str>) -> Option<usize> {
    running
        .iter()
        .position(|r| *r)
        .or_else(|| active.and_then(|a| ids.iter().position(|id| *id == a)))
        .or(if ids.is_empty() { None } else { Some(0) })
}

/// Moves every configuration of `source` to `target`. Nothing is stopped
/// before all migrated copies exist; a failed primary switch restores the
/// previous runtime and leaves the others untouched.
pub(super) async fn switch_profiles(
    state: Arc<RuntimeState>,
    task_id: &str,
    source: &Path,
    target: &SwitchTarget,
) -> Result<String, String> {
    let source = dunce::canonicalize(source).map_err(|_| "原运行环境目录不存在")?;
    let target = SwitchTarget {
        root: dunce::canonicalize(&target.root).map_err(|_| "目标运行环境目录不存在")?,
        python: target.python.clone(),
    };
    if source == target.root {
        return Err("已在使用此运行环境".into());
    }
    if !Path::new(&target.python).is_file() {
        return Err("目标运行环境的私有 Python 不存在，未切换".into());
    }
    let associated = release_zip::profiles(&state, &source)?;
    for profile in &associated {
        crate::external_management::assert_profile_manager_owned(&state, profile)?;
    }
    let (configured, bare): (Vec<_>, Vec<_>) = associated
        .into_iter()
        .partition(|p| !p.config_path.is_empty());
    let mut prepared = Vec::new();
    for profile in &configured {
        prepared.push(prepare(&state, task_id, profile, &source, &target)?);
    }
    let running = configured
        .iter()
        .map(|p| running_owned(&state, &p.id))
        .collect::<Result<Vec<_>, _>>()?;
    let ids: Vec<&str> = configured.iter().map(|p| p.id.as_str()).collect();
    let active = crate::store_get(&state, "activeLocalInstallation".into())?;
    let primary = primary_index(&running, &ids, active.as_str());
    if let Some(index) = primary {
        let item = &prepared[index];
        let mut journal = Journal {
            task_id: task_id.into(),
            profile_id: item.old.id.clone(),
            phase: "candidateReady".into(),
            old: item.old.clone(),
            candidate: Some(item.candidate.clone()),
            old_config_sha256: item.old_sha256.clone(),
            candidate_config_sha256: Some(item.candidate_sha256.clone()),
            was_running: false,
            was_loaded: false,
            old_active: active.clone(),
            old_desired: crate::store_get(&state, "localServiceDesired".into())?,
            error: None,
            updated_at: now(),
        };
        persist(&state, &journal)?;
        switch(state.clone(), &mut journal).await?;
    }
    let mut moved = usize::from(primary.is_some());
    let mut kept = Vec::new();
    for (index, item) in prepared.iter().enumerate() {
        if Some(index) == primary {
            continue;
        }
        let result = (|| {
            if running_owned(&state, &item.old.id)? {
                return Err("服务正在运行".to_string());
            }
            if installation::file_hash(&storage::config_path(&item.old)?)? != item.old_sha256 {
                return Err("配置在切换期间发生变化".into());
            }
            registry_replace(&state, &item.old, &item.candidate)
        })();
        match result {
            Ok(()) => moved += 1,
            Err(error) => kept.push(format!("{}（{error}）", item.old.name)),
        }
    }
    for profile in &bare {
        let mut candidate = profile.clone();
        candidate.install_dir = target.root.to_string_lossy().into();
        candidate.python_path = target.python.clone();
        let _ = registry_replace(&state, profile, &candidate);
    }
    processes::log(
        &state.logs,
        task_id,
        "info",
        format!(
            "已切换 {moved} 个配置到 {}；原运行环境 {} 保持原样",
            target.root.display(),
            source.display()
        ),
    );
    Ok(if kept.is_empty() {
        format!("{moved} 个配置已切换，验收通过")
    } else {
        format!(
            "{moved} 个配置已切换；以下配置仍使用原运行环境：{}",
            kept.join("、")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(root: &Path, name: &str, build: Value) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(exe_name("strata")), "engine").unwrap();
        fs::write(dir.join("BUILD.json"), build.to_string()).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn profile(root: &Path) -> ServiceProfile {
        ServiceProfile {
            id: "configuration-a".into(),
            name: "A".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: String::new(),
            config_path: root.join("strata-a.json").to_string_lossy().into(),
            managed: true,
        }
    }

    #[test]
    fn migration_points_to_target_engine_and_keeps_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("user");
        let target = temp.path().join("release-new");
        fs::create_dir_all(source.join("models")).unwrap();
        fs::create_dir_all(source.join("packs/tok")).unwrap();
        fs::write(source.join("packs/tok/vocab.json"), "{}").unwrap();
        fs::write(source.join("models/m.gguf"), "m").unwrap();
        fs::create_dir_all(&target).unwrap();
        let source = dunce::canonicalize(source).unwrap();
        let target = dunce::canonicalize(target).unwrap();
        let old_engine = engine(&source, "engine", json!({"version":"0.1.47","cuda":"13.0"}));
        let new_engine = engine(&target, "engine", json!({"version":"0.1.48","cuda":"13.0"}));
        let config = json!({
            "exe": old_engine.join(exe_name("strata")),
            "cwd": source,
            "args": ["--native", "models/m.gguf", "--max-context", "8192", "--prefill", "auto"],
            "tokenizer": "packs/tok",
            "log": "strata.log",
            "lib_dirs": [old_engine],
        });
        let out = migrate(&profile(&source), &config, &source, &target).unwrap();
        assert_eq!(out["exe"], json!(new_engine.join(exe_name("strata"))));
        assert_eq!(out["cwd"], json!(target));
        assert_eq!(out["args"][1], json!(source.join("models/m.gguf")));
        assert_eq!(out["args"][3], json!("8192"));
        assert_eq!(out["args"][5], json!("auto"));
        assert_eq!(out["tokenizer"], json!(source.join("packs/tok")));
        assert_eq!(out["log"], json!(target.join("strata.log")));
        // The old engine folder is inside the source runtime: it is never kept as a library folder.
        assert_eq!(out["lib_dirs"], json!([new_engine]));
    }

    #[test]
    fn migration_keeps_a_custom_cwd_and_refuses_foreign_engines() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("user");
        let target = temp.path().join("release-new");
        let work = temp.path().join("work");
        for dir in [&source, &target, &work] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::create_dir_all(work.join("tok")).unwrap();
        fs::write(work.join("tok/vocab.json"), "{}").unwrap();
        let source = dunce::canonicalize(source).unwrap();
        let target = dunce::canonicalize(target).unwrap();
        let work = dunce::canonicalize(work).unwrap();
        engine(
            &source,
            "engine-cuda12",
            json!({"version":"0.1.47","cuda":"12.9"}),
        );
        engine(
            &target,
            "engine-cuda12",
            json!({"version":"0.1.48","cuda":"12.9"}),
        );
        let config = json!({"exe": source.join("engine-cuda12").join(exe_name("strata")), "cwd": work, "args": ["m.gguf"], "tokenizer": work.join("tok")});
        let out = migrate(&profile(&source), &config, &source, &target).unwrap();
        assert_eq!(out["cwd"], json!(work));
        assert_eq!(out["args"][0], json!("m.gguf"));
        assert!(out["exe"].as_str().unwrap().contains("release-new"));

        let foreign = engine(&work, "engine", json!({"version":"0.1.47"}));
        let config = json!({"exe": foreign.join(exe_name("strata")), "cwd": work, "tokenizer": work.join("tok")});
        let error = migrate(&profile(&source), &config, &source, &target).unwrap_err();
        assert!(error.contains("运行环境之外的引擎"), "{error}");
    }

    #[test]
    fn migration_refuses_a_missing_or_different_engine() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("user");
        let target = temp.path().join("release-new");
        fs::create_dir_all(source.join("tok")).unwrap();
        fs::write(source.join("tok/vocab.json"), "{}").unwrap();
        fs::create_dir_all(&target).unwrap();
        let source = dunce::canonicalize(source).unwrap();
        let target = dunce::canonicalize(target).unwrap();
        let old = engine(
            &source,
            "engine-cuda12",
            json!({"version":"0.1.47","cuda":"12.9"}),
        );
        let config =
            json!({"exe": old.join(exe_name("strata")), "cwd": source, "tokenizer": "tok"});
        let error = migrate(&profile(&source), &config, &source, &target).unwrap_err();
        assert!(error.contains("缺少对应的引擎"), "{error}");
        engine(
            &target,
            "engine-cuda12",
            json!({"version":"0.1.48","cuda":"13.0"}),
        );
        let error = migrate(&profile(&source), &config, &source, &target).unwrap_err();
        assert!(error.contains("引擎类型"), "{error}");
    }

    #[test]
    fn path_arguments_need_a_separator_or_extension() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("auto"), "").unwrap();
        fs::write(temp.path().join("m.gguf"), "").unwrap();
        assert!(relative_path_argument(temp.path(), "auto").is_none());
        assert!(relative_path_argument(temp.path(), "1.5").is_none());
        assert!(relative_path_argument(temp.path(), "--native").is_none());
        assert!(relative_path_argument(temp.path(), "missing.gguf").is_none());
        assert_eq!(
            relative_path_argument(temp.path(), "m.gguf"),
            Some(temp.path().join("m.gguf"))
        );
    }

    #[test]
    fn primary_is_running_then_selected_then_first() {
        assert_eq!(
            primary_index(&[false, true], &["a", "b"], Some("a")),
            Some(1)
        );
        assert_eq!(
            primary_index(&[false, false], &["a", "b"], Some("b")),
            Some(1)
        );
        assert_eq!(primary_index(&[false, false], &["a", "b"], None), Some(0));
        assert_eq!(primary_index(&[], &[], Some("a")), None);
    }

    fn python() -> String {
        let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
        command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
        processes::hidden(&mut command);
        let result = command
            .output()
            .expect("Python is required for switch fixtures");
        String::from_utf8(result.stdout).unwrap().trim().into()
    }

    struct Fixture {
        state: Arc<RuntimeState>,
        old: ServiceProfile,
        source: PathBuf,
        target: SwitchTarget,
        task_id: String,
        hashes: Vec<(PathBuf, String)>,
        _temp: tempfile::TempDir,
    }

    /// A user-installed runtime with its configuration inside the user folder,
    /// and a prepared runtime in the Manager's runtimes folder.
    fn fixture(target_server: &str) -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("user-install");
        fs::create_dir_all(source.join("serve")).unwrap();
        fs::create_dir_all(source.join("tokenizer")).unwrap();
        fs::write(source.join("setup.py"), "# user setup fixture").unwrap();
        fs::write(
            source.join("serve/server.py"),
            include_str!("../../tests/fixtures/runtime_upgrade_service.py"),
        )
        .unwrap();
        for name in ["vocab.json", "merges.txt", "token_type.json"] {
            fs::write(source.join("tokenizer").join(name), "{}\n").unwrap();
        }
        fs::write(source.join("model.gguf"), "synthetic weights; never loaded").unwrap();
        let source = dunce::canonicalize(source).unwrap();
        let old_engine = engine(&source, "engine", json!({"version":"0.1.47","cuda":"13.0"}));
        let data = temp.path().join("data");
        let state = RuntimeState::open(data.clone()).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let python = python();
        let old = ServiceProfile {
            id: "switch-fixture".into(),
            name: "我的配置".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: source.to_string_lossy().into(),
            python_path: python.clone(),
            config_path: source.join("strata-a.json").to_string_lossy().into(),
            managed: true,
        };
        let config = json!({"exe": old_engine.join(exe_name("strata")), "args":["--native","model.gguf"], "cwd": source, "tokenizer":"tokenizer", "model_name":"switch-fixture-model", "log":"strata.log"});
        fs::write(
            &old.config_path,
            serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("strata-a.shared-settings.json"),
            "{\"temperature\":0.4}\n",
        )
        .unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
                params![
                    old.id,
                    serde_json::to_string(&old).unwrap(),
                    serde_json::to_string(&old).unwrap(),
                    now() as i64
                ],
            )
            .unwrap();
        crate::store_set(&state, "activeLocalInstallation".into(), json!(old.id)).unwrap();
        crate::store_set(&state, "localServiceDesired".into(), json!(true)).unwrap();
        let root = installation::owned_directory(state.data_dir(), &["runtimes"])
            .unwrap()
            .join("release-new");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), "# prepared setup fixture").unwrap();
        fs::write(root.join("serve/server.py"), target_server).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        engine(&root, "engine", json!({"version":"0.1.48","cuda":"13.0"}));
        let task_id = uuid::Uuid::new_v4().to_string();
        let task = processes::TaskRecord {
            status: TaskStatus {
                id: task_id.clone(),
                kind: "update".into(),
                state: "running".into(),
                message: "switch fixture".into(),
                started_at: now(),
                finished_at: None,
            },
            profile_id: Some(old.id.clone()),
            runtime_path: None,
            cancelled: false,
            process: None,
        };
        processes::persist_task(&state.database, &task).unwrap();
        state.tasks.lock().unwrap().insert(task_id.clone(), task);
        let hashes = walk(&source)
            .into_iter()
            .map(|p| {
                let hash = installation::file_hash(&p).unwrap();
                (p, hash)
            })
            .collect();
        Fixture {
            state,
            old,
            source,
            target: SwitchTarget { root, python },
            task_id,
            hashes,
            _temp: temp,
        }
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            // Service start's own runtime lock, created by any start of the old service.
            if entry.file_name() == ".ipc" {
                continue;
            }
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out.sort();
        out
    }

    fn untouched(f: &Fixture) {
        let now: Vec<_> = walk(&f.source);
        let before: Vec<_> = f.hashes.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(now, before, "files added to the user folder");
        for (path, hash) in &f.hashes {
            assert_eq!(
                &installation::file_hash(path).unwrap(),
                hash,
                "{}",
                path.display()
            );
        }
    }

    async fn start_old(f: &Fixture) {
        start_candidate(f.state.clone(), f.old.clone())
            .await
            .unwrap();
        verify(&f.state, &f.old, None, None, true, false)
            .await
            .unwrap();
        f.state.owned_gui_profile(&f.old.id).unwrap();
    }

    async fn health(f: &Fixture) -> Value {
        http::strata_request(
            &f.state,
            f.state.registered_profile(&f.old.id).unwrap(),
            "/health".into(),
            "GET".into(),
            None,
        )
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn running_service_switches_to_the_new_runtime_and_keeps_the_old_folder() {
        let f = fixture(include_str!(
            "../../tests/fixtures/runtime_upgrade_service.py"
        ));
        start_old(&f).await;
        let summary = switch_profiles(f.state.clone(), &f.task_id, &f.source, &f.target)
            .await
            .unwrap();
        assert!(summary.contains("1 个配置已切换"), "{summary}");
        let current = f.state.registered_profile(&f.old.id).unwrap();
        assert_eq!(Path::new(&current.install_dir), f.target.root);
        assert_eq!(current.name, f.old.name);
        let config = Path::new(&current.config_path);
        assert!(config.starts_with(f.state.data_dir().join(CONFIG_DIR).join(&f.task_id)));
        assert!(config
            .with_file_name("strata-a.shared-settings.json")
            .is_file());
        let migrated = storage::read(&current).unwrap();
        assert!(migrated["exe"]
            .as_str()
            .unwrap()
            .starts_with(&*f.target.root.to_string_lossy()));
        assert_eq!(migrated["args"][1], json!(f.source.join("model.gguf")));
        let health = health(&f).await;
        assert_eq!(
            (health["status"].as_str(), health["loaded"].as_bool()),
            (Some("ok"), Some(true))
        );
        assert_eq!(health["shared"], json!({"temperature":0.4}));
        untouched(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failing_new_runtime_reverts_to_the_old_one_and_keeps_it_serving() {
        let f = fixture("raise SystemExit(3)\n");
        start_old(&f).await;
        let error = switch_profiles(f.state.clone(), &f.task_id, &f.source, &f.target)
            .await
            .unwrap_err();
        assert!(!error.is_empty());
        let current = f.state.registered_profile(&f.old.id).unwrap();
        assert_eq!(current.install_dir, f.old.install_dir);
        assert_eq!(current.config_path, f.old.config_path);
        let health = health(&f).await;
        assert_eq!(
            (health["status"].as_str(), health["loaded"].as_bool()),
            (Some("ok"), Some(true))
        );
        assert_eq!(
            crate::store_get(&f.state, "activeLocalInstallation".into()).unwrap(),
            json!(f.old.id)
        );
        untouched(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }

    async fn switch_task(f: &Fixture) -> TaskStatus {
        switch_task_to(f, &f.target.root).await
    }

    async fn switch_task_to(f: &Fixture, root: &Path) -> TaskStatus {
        // The fixture's own placeholder task would block a new runtime task.
        f.state.tasks.lock().unwrap().remove(&f.task_id);
        let inventory = super::super::installed_runtimes::inventory(&f.state).unwrap();
        let target = inventory
            .runtimes
            .iter()
            .find(|r| Path::new(&r.install_dir) == root)
            .unwrap_or_else(|| panic!("target not listed: {inventory:?}"));
        assert!(!target.current, "{target:?}");
        let status = super::super::installed_runtimes::start_switch(
            f.state.clone(),
            target.install_dir.clone(),
            None,
        )
        .unwrap();
        for _ in 0..600 {
            let task = f.state.tasks.lock().unwrap()[&status.id].status.clone();
            if task.state != "running" {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("switch task did not finish");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn switching_to_an_installed_version_keeps_the_previous_one_for_rollback() {
        let f = fixture(include_str!(
            "../../tests/fixtures/runtime_upgrade_service.py"
        ));
        start_old(&f).await;
        let task = switch_task(&f).await;
        assert_eq!(task.state, "completed", "{}", task.message);
        assert!(task.message.contains("原版本"), "{}", task.message);
        let current = f.state.registered_profile(&f.old.id).unwrap();
        assert_eq!(Path::new(&current.install_dir), f.target.root);
        assert_eq!(health(&f).await["loaded"], true);
        let inventory = super::super::installed_runtimes::inventory(&f.state).unwrap();
        let old = inventory
            .runtimes
            .iter()
            .find(|r| Path::new(&r.install_dir) == f.source)
            .unwrap();
        assert!(old.rollback && !old.cleanup && !old.current);
        assert!(f.source.is_dir());
        // Rollback: switch back to the kept version, again without downloading.
        let back = switch_task_to(&f, &f.source).await;
        assert_eq!(back.state, "completed", "{}", back.message);
        let current = f.state.registered_profile(&f.old.id).unwrap();
        assert_eq!(Path::new(&current.install_dir), f.source);
        assert_eq!(health(&f).await["loaded"], true);
        assert!(
            f.target.root.is_dir(),
            "the newer version stays installed too"
        );
        untouched(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failing_switch_to_an_installed_version_restores_the_current_one() {
        let f = fixture("raise SystemExit(3)\n");
        start_old(&f).await;
        let task = switch_task(&f).await;
        assert_eq!(task.state, "failed");
        assert!(task.message.contains("已恢复原版本"), "{}", task.message);
        let current = f.state.registered_profile(&f.old.id).unwrap();
        assert_eq!(current.install_dir, f.old.install_dir);
        assert_eq!(health(&f).await["loaded"], true);
        assert!(f.target.root.is_dir(), "the target stays installed");
        assert!(!f.state.runtime_upgrading.load(Ordering::Acquire));
        untouched(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_configuration_that_cannot_migrate_stops_nothing() {
        let f = fixture(include_str!(
            "../../tests/fixtures/runtime_upgrade_service.py"
        ));
        fs::remove_dir_all(f.target.root.join("engine")).unwrap();
        start_old(&f).await;
        let error = switch_profiles(f.state.clone(), &f.task_id, &f.source, &f.target)
            .await
            .unwrap_err();
        assert!(error.contains("缺少对应的引擎"), "{error}");
        assert_eq!(health(&f).await["loaded"], true);
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
        untouched(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
}
