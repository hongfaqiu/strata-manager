use super::*;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

struct Read {
    result: Result<Vec<String>, String>,
    exit: bool,
    generation: Option<u64>,
}
struct Plan {
    created: u64,
    exited: bool,
    exit_at: Option<usize>,
    checks: usize,
    reads: VecDeque<Read>,
}
impl Plan {
    fn args(args: Vec<String>) -> Self {
        Self {
            created: 1,
            exited: false,
            exit_at: None,
            checks: 0,
            reads: VecDeque::from([Read {
                result: Ok(args),
                exit: false,
                generation: None,
            }]),
        }
    }
}
struct Fake {
    snapshots: VecDeque<Result<Vec<u32>, ScanError>>,
    opens: VecDeque<Result<Rc<RefCell<Plan>>, ScanError>>,
    calls: usize,
    held: usize,
}
impl Fake {
    fn new(snapshots: Vec<Vec<u32>>, plans: Vec<Plan>) -> Self {
        Self {
            snapshots: snapshots.into_iter().map(Ok).collect(),
            opens: plans
                .into_iter()
                .map(|plan| Ok(Rc::new(RefCell::new(plan))))
                .collect(),
            calls: 0,
            held: 0,
        }
    }
}
impl Census for Fake {
    type Held = Rc<RefCell<Plan>>;
    fn snapshot(&mut self, _: Instant) -> Result<Vec<u32>, ScanError> {
        if self.snapshots.len() > 1 {
            self.snapshots.pop_front().unwrap()
        } else {
            self.snapshots
                .front()
                .cloned()
                .unwrap_or_else(|| Ok(Vec::new()))
        }
    }
    fn hold(&mut self, _: u32) -> Result<Self::Held, ScanError> {
        self.held += 1;
        self.opens.pop_front().unwrap_or(Err(ScanError::Changed))
    }
    fn exited(&mut self, held: &Self::Held) -> Result<bool, String> {
        let mut plan = held.borrow_mut();
        plan.checks += 1;
        if plan.exit_at.is_some_and(|count| plan.checks >= count) {
            plan.exited = true;
        }
        Ok(plan.exited)
    }
    fn identity(&mut self, held: &Self::Held) -> Result<(u64, PathBuf), String> {
        Ok((
            held.borrow().created,
            PathBuf::from(r"C:\fixture\python.exe"),
        ))
    }
    fn command(&mut self, held: &Self::Held) -> Result<Vec<String>, String> {
        self.calls += 1;
        let mut plan = held.borrow_mut();
        let event = plan.reads.pop_front().expect("unexpected command retry");
        plan.exited = event.exit;
        if let Some(created) = event.generation {
            plan.created = created;
        }
        event.result
    }
}
fn args() -> Vec<String> {
    [r"C:\fixture\python.exe", "-I", "-c", "pass"]
        .map(String::from)
        .to_vec()
}
fn strata(config: &std::path::Path) -> Vec<String> {
    vec![
        r"C:\fixture\python.exe".into(),
        "-m".into(),
        "serve.server".into(),
        "--config".into(),
        config.to_string_lossy().into(),
    ]
}
fn run(source: &mut Fake) -> Result<Vec<ProcessHint>, String> {
    collect(source, Instant::now() + BUDGET)
}

#[test]
fn held_exit_before_or_during_command_read_is_safely_excluded() {
    let mut before = Plan::args(args());
    before.exited = true;
    let mut source = Fake::new(vec![vec![1], vec![]], vec![before]);
    assert!(run(&mut source).unwrap().is_empty());
    assert_eq!(source.calls, 0);
    let mut during = Plan::args(args());
    during.reads[0] = Read {
        result: Err("query failed while exiting".into()),
        exit: true,
        generation: None,
    };
    let mut source = Fake::new(vec![vec![1], vec![]], vec![during]);
    assert!(run(&mut source).unwrap().is_empty());
    assert_eq!(source.calls, 1);
}

#[test]
fn live_unknown_argv_and_permission_failure_never_prove_absence() {
    let mut plan = Plan::args(args());
    plan.reads = (0..2)
        .map(|_| Read {
            result: Err("live argv unavailable".into()),
            exit: false,
            generation: None,
        })
        .collect();
    let mut source = Fake::new(vec![vec![1]], vec![plan]);
    assert!(run(&mut source)
        .unwrap_err()
        .contains("live argv unavailable"));
    assert_eq!(source.calls, 2);
    let mut source = Fake::new(vec![vec![1]], vec![]);
    source
        .opens
        .push_back(Err(ScanError::Rejected("ACCESS_DENIED".into())));
    assert_eq!(run(&mut source).unwrap_err(), "ACCESS_DENIED");
    assert_eq!(source.held, 1);
    assert_eq!(source.calls, 0);
}

#[test]
fn initializing_live_process_has_only_one_bounded_same_handle_retry() {
    let mut plan = Plan::args(args());
    plan.reads.push_front(Read {
        result: Err("initializing".into()),
        exit: false,
        generation: None,
    });
    let mut source = Fake::new(vec![vec![1]], vec![plan]);
    assert!(run(&mut source).unwrap().is_empty());
    assert_eq!(source.calls, 2);
    assert_eq!(source.held, 1);
}

#[test]
fn malformed_live_argv_is_rejected_without_reattempt_or_absence_claim() {
    for command in [
        vec![],
        vec!["x".into(); 257],
        vec!["x".repeat(128 * 1024 + 1)],
    ] {
        let mut source = Fake::new(vec![vec![1]], vec![Plan::args(command)]);
        assert!(run(&mut source).is_err());
        assert_eq!(source.calls, 1);
    }
}

#[test]
fn held_identity_change_never_reuses_previously_read_arguments() {
    let mut plan = Plan::args(args());
    plan.reads[0].generation = Some(2);
    let mut source = Fake::new(vec![vec![1]], vec![plan]);
    assert!(run(&mut source).unwrap_err().contains("身份变化"));
    assert_eq!(source.calls, 1);
}

#[test]
fn newly_added_python_is_read_and_a_strata_generation_is_not_missed() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("config.json");
    std::fs::write(&config, b"{}").unwrap();
    let mut source = Fake::new(
        vec![vec![1], vec![1, 2], vec![1, 2], vec![1, 2]],
        vec![
            Plan::args(args()),
            Plan::args(args()),
            Plan::args(strata(&config)),
        ],
    );
    let hints = run(&mut source).unwrap();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].config, config);
    assert_eq!(source.calls, 3);
}

#[test]
fn reused_pid_requires_new_handle_and_new_generation_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("new.json");
    std::fs::write(&config, b"{}").unwrap();
    let mut old = Plan::args(args());
    old.reads[0].exit = true;
    let mut new = Plan::args(strata(&config));
    new.created = 2;
    let mut source = Fake::new(vec![vec![1]], vec![old, Plan::args(args()), new]);
    let hints = run(&mut source).unwrap();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].config, config);
    assert_eq!(source.calls, 2);
    assert_eq!(source.held, 3);
}

#[test]
fn missing_strata_config_blocks_live_process_but_not_a_proven_exit() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("not-present.json");
    let mut source = Fake::new(vec![vec![1]], vec![Plan::args(strata(&config))]);
    assert!(run(&mut source).unwrap_err().contains("无法定位配置"));
    let mut plan = Plan::args(strata(&config));
    plan.exit_at = Some(6);
    let mut source = Fake::new(vec![vec![1]], vec![plan]);
    assert!(run(&mut source).unwrap().is_empty());
    assert_eq!(source.calls, 1);
}

#[test]
fn vanished_before_hold_rebuilds_complete_snapshot_and_churn_stays_bounded() {
    let mut source = Fake::new(vec![vec![1], vec![], vec![]], vec![]);
    assert!(run(&mut source).unwrap().is_empty());
    assert_eq!(source.held, 1);
    let mut source = Fake::new(vec![vec![1]], vec![]);
    assert!(run(&mut source).unwrap_err().contains("持续变化"));
    assert_eq!(source.held, MAX_PASSES);
}

#[test]
fn census_limits_and_original_budget_fail_closed() {
    for pids in [(1..=65).collect(), vec![1, 1], vec![0]] {
        let mut source = Fake::new(vec![pids], vec![]);
        assert!(run(&mut source).is_err());
        assert_eq!(source.held, 0);
    }
    let mut source = Fake::new(vec![vec![]], vec![]);
    assert!(
        collect(&mut source, Instant::now() - Duration::from_millis(1))
            .unwrap_err()
            .contains("时间预算")
    );
}

#[test]
fn incomplete_inventory_cannot_authorize_any_partial_hint() {
    let mut source = Fake::new(vec![], vec![Plan::args(args())]);
    source
        .snapshots
        .push_back(Err(ScanError::Rejected("incomplete inventory".into())));
    assert_eq!(run(&mut source).unwrap_err(), "incomplete inventory");
    assert_eq!(source.held, 0);
    assert_eq!(source.calls, 0);
}

#[test]
fn complete_native_entry_limit_is_preserved_before_python_filtering() {
    assert!(process_count(4096).is_ok());
    assert!(matches!(process_count(4097), Err(ScanError::Rejected(_))));
}

struct ChildFixture {
    child: std::process::Child,
    directory: tempfile::TempDir,
}
impl Drop for ChildFixture {
    fn drop(&mut self) {
        let _ = std::fs::write(self.directory.path().join("stop"), b"stop");
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
fn child_fixture() -> (ChildFixture, PathBuf) {
    let python = ["py", "python"]
        .into_iter()
        .find_map(|program| {
            crate::output(
                program,
                &["-I", "-S", "-c", "import sys;print(sys.executable)"],
            )
        })
        .expect("Python required for private CPU census fixture");
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("模型 配置.json");
    std::fs::write(&config, b"{}").unwrap();
    let code = "import pathlib,sys,time;root=pathlib.Path(sys.argv[1]);(root/'ready').write_text('ready');deadline=time.monotonic()+10\nwhile not (root/'stop').exists() and time.monotonic()<deadline:time.sleep(.01)";
    let mut command = std::process::Command::new(python);
    command
        .args(["-I", "-S", "-c", code])
        .arg(directory.path())
        .args(["-m", "serve.server", "--config"])
        .arg(&config);
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::processes::hidden(&mut command);
    let child = command.spawn().unwrap();
    let mut fixture = ChildFixture { child, directory };
    let deadline = Instant::now() + Duration::from_secs(3);
    while !fixture.directory.path().join("ready").is_file() {
        assert!(
            fixture.child.try_wait().unwrap().is_none(),
            "private CPU child exited before ready"
        );
        assert!(
            Instant::now() < deadline,
            "private CPU child readiness deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    (fixture, config)
}

// The OS tests query only their own private child handles. Native snapshot
// collection in production remains complete; no host filtering switch exists.
struct PrivateNative {
    pid: u32,
    held: Option<Held>,
    include: bool,
}
impl Census for PrivateNative {
    type Held = Held;
    fn snapshot(&mut self, _: Instant) -> Result<Vec<u32>, ScanError> {
        Ok(if self.include { vec![self.pid] } else { vec![] })
    }
    fn hold(&mut self, pid: u32) -> Result<Held, ScanError> {
        assert_eq!(pid, self.pid);
        self.held.take().map(Ok).unwrap_or_else(|| Native.hold(pid))
    }
    fn exited(&mut self, held: &Held) -> Result<bool, String> {
        Native.exited(held)
    }
    fn identity(&mut self, held: &Held) -> Result<(u64, PathBuf), String> {
        Native.identity(held)
    }
    fn command(&mut self, held: &Held) -> Result<Vec<String>, String> {
        Native.command(held)
    }
}

#[test]
fn own_cpu_python_handle_preserves_unicode_config_and_does_not_stop_child() {
    let (mut fixture, config) = child_fixture();
    let mut source = PrivateNative {
        pid: fixture.child.id(),
        held: None,
        include: true,
    };
    let hints = collect(&mut source, Instant::now() + BUDGET).unwrap();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].config, config);
    assert!(
        fixture.child.try_wait().unwrap().is_none(),
        "read-only census must keep its child alive"
    );
}

#[test]
fn own_cpu_python_exit_is_proved_by_same_held_os_generation() {
    let (mut fixture, _) = child_fixture();
    let held = Native.hold(fixture.child.id()).unwrap();
    assert!(!Native.exited(&held).unwrap());
    std::fs::write(fixture.directory.path().join("stop"), b"stop").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while fixture.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(Native.exited(&held).unwrap());
    assert!(observe(&mut Native, &held, Instant::now() + BUDGET)
        .unwrap()
        .is_none());
}
