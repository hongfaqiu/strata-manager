#!/usr/bin/env python3
"""Bash wrapper contracts using temporary PATH stubs, not a real Secret Service."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


WRAPPER = Path(__file__).resolve().parents[1] / "release-linux-tests.sh"
PRIVATE_ENV = ("XDG_DATA_HOME", "XDG_RUNTIME_DIR", "GNOME_KEYRING_CONTROL")
STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
root = pathlib.Path(os.environ['STUB_ROOT'])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
env = {key: os.environ.get(key) for key in ('XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'GNOME_KEYRING_CONTROL')}
event = {'name': name, 'args': args, 'env': env}
with (root / 'events.jsonl').open('a') as log:
    log.write(json.dumps(event) + '\n')
def pid():
    return int((root / 'daemon.pid').read_text())
def alive():
    if not (root / 'daemon.pid').exists() or (root / 'daemon.stopped').exists():
        return False
    try:
        os.kill(pid(), 0)
        return True
    except ProcessLookupError:
        return False
if name == 'dbus-update-activation-environment':
    assert args == ['XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'GNOME_KEYRING_CONTROL']
    (root / 'activation.json').write_text(json.dumps(env))
elif name == 'gnome-keyring-daemon':
    assert sys.stdin.read() == 'strata-manager-ci-fixture'
    assert args[-2:] == ['--control-directory', env['GNOME_KEYRING_CONTROL']]
    assert json.loads((root / 'activation.json').read_text()) == env
    (root / 'daemon.pid').write_text(str(os.getpid()))
    print('stub-daemon-stdout: private control=' + env['GNOME_KEYRING_CONTROL'], flush=True)
    print('stub-daemon-stderr: started', file=sys.stderr, flush=True)
    if os.environ['STUB_CASE'] == 'stubborn-daemon':
        signal.signal(signal.SIGTERM, lambda *_: (root / 'daemon.term').touch())
    else:
        def terminate(*_):
            (root / 'daemon.term').touch()
            if (root / 'command.started').exists() and not (root / 'command.finished').exists():
                (root / 'daemon.term-before-command').touch()
            sys.exit(0)
        signal.signal(signal.SIGTERM, terminate)
    while not (root / 'contract.stop').exists():
        if (root / 'daemon.die').exists():
            (root / 'daemon.stopped').touch()
            print('stub-daemon-stderr: deliberate exit 23', file=sys.stderr, flush=True)
            sys.exit(23)
        time.sleep(.02)
elif name == 'gdbus':
    if args[0] == 'wait':
        end = time.monotonic() + 3
        while not alive() and time.monotonic() < end:
            time.sleep(.01)
        sys.exit(0 if alive() else 1)
    method = args[args.index('--method') + 1]
    destination = args[args.index('--dest') + 1]
    if method.endswith('.GetNameOwner'):
        assert destination == 'org.freedesktop.DBus'
        if not alive():
            print('stub: NameHasNoOwner', file=sys.stderr)
            sys.exit(1)
        print("(':1.43',)" if (root / 'owner.replace').exists() else "(':1.42',)")
    elif method.endswith('.GetConnectionUnixProcessID'):
        assert destination == 'org.freedesktop.DBus'
        actual = pid() + (1 if os.environ['STUB_CASE'] == 'owner-mismatch' or args[-1] == ':1.43' else 0)
        print('(uint32 %d,)' % actual)
    else:
        assert destination.startswith(':1.'), 'must not activate a replacement'
        if method.endswith('.ReadAlias'):
            print("(objectpath '/org/freedesktop/secrets/collection/login',)")
        elif method.endswith('.SetAlias'):
            print('()')
        elif method.endswith('.Get'):
            print('(<false>,)')
        else:
            raise AssertionError(method)
elif name == 'secret-tool':
    value = root / 'fixture.secret'
    if args[0] == 'store':
        value.write_text(sys.stdin.read())
    elif args[0] == 'lookup':
        if not value.exists():
            sys.exit(1)
        print(value.read_text())
    elif args[0] == 'clear':
        value.unlink()
    else:
        raise AssertionError(args)
elif name == 'fixture-command':
    (root / 'command.started').touch()
    (root / 'command.env').write_text(json.dumps(env))
    scenario = os.environ['STUB_CASE']
    if scenario in ('daemon-death', 'combined-failure'):
        (root / 'daemon.die').touch()
    elif scenario == 'owner-replacement':
        (root / 'owner.replace').touch()
    elif scenario == 'interrupted-wrapper':
        os.kill(os.getppid(), signal.SIGTERM)
    if scenario in ('daemon-death', 'combined-failure', 'owner-replacement'):
        failure = pathlib.Path(env['XDG_DATA_HOME']).parent / 'monitor.failure'
        end = time.monotonic() + 4
        while not failure.exists() and time.monotonic() < end:
            time.sleep(.02)
        assert failure.exists(), 'owner supervision did not detect the fault during the command'
    elif scenario == 'interrupted-wrapper':
        end = time.monotonic() + 4
        while not (root / 'daemon.term').exists() and time.monotonic() < end:
            time.sleep(.02)
        assert (root / 'daemon.term').exists(), 'cleanup waited for the command before stopping its daemon'
    else:
        time.sleep(.8)
    (root / 'command.finished').touch()
    sys.exit(37 if scenario in ('command-failure', 'combined-failure') else 0)
else:
    raise AssertionError(name)
'''


def contract(scenario, expected_status, expected_diagnostic=None):
    with tempfile.TemporaryDirectory(prefix="strata-keyring-contract-") as temporary:
        root = Path(temporary)
        binaries = root / "bin"
        binaries.mkdir()
        for name in ("dbus-update-activation-environment", "gnome-keyring-daemon", "gdbus", "secret-tool", "fixture-command"):
            binary = binaries / name
            binary.write_text(STUB)
            binary.chmod(0o700)
        environment = os.environ.copy()
        environment.update({
            "PATH": str(binaries) + os.pathsep + environment["PATH"],
            "STUB_ROOT": str(root), "STUB_CASE": scenario,
            "RUNNER_TEMP": str(root), "DBUS_SESSION_BUS_ADDRESS": "unix:path=/contract-only-bus",
            **{key: "/contract-original/" + key.lower() for key in PRIVATE_ENV},
        })
        process = subprocess.Popen(["bash", str(WRAPPER), "fixture-command"], env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=15)
            result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
            if (root / "daemon.pid").exists():
                daemon_pid = int((root / "daemon.pid").read_text())
                try:
                    os.kill(daemon_pid, 0)
                except ProcessLookupError:
                    pass
                else:
                    raise AssertionError(f"wrapper left its stub daemon {daemon_pid} alive")
        finally:
            # Stops only this stub if a broken wrapper fails to clean up its child.
            (root / "contract.stop").touch()
            if process.poll() is None:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
            # Keep the stop file alive until a remaining disposable daemon has
            # observed it; deleting the temp directory earlier would lose it.
            deadline = time.monotonic() + 3
            while (root / "daemon.pid").exists() and time.monotonic() < deadline:
                try:
                    os.kill(int((root / "daemon.pid").read_text()), 0)
                except ProcessLookupError:
                    break
                time.sleep(.02)
        combined = result.stdout + result.stderr
        assert result.returncode == expected_status, (scenario, result.returncode, combined)
        assert "stub-daemon-stdout" in combined and "stub-daemon-stderr" in combined, combined
        assert "Secret Service daemon exit status:" in combined, combined
        assert "Secret Service diagnostic: current owner=" in combined or "NameHasNoOwner" in combined, combined
        if expected_diagnostic:
            assert expected_diagnostic in combined, combined
        forwarded = json.loads((root / "activation.json").read_text())
        assert all(Path(forwarded[key]).is_relative_to(root) for key in PRIVATE_ENV), forwarded
        assert Path(forwarded["XDG_DATA_HOME"]).parent == Path(forwarded["GNOME_KEYRING_CONTROL"]).parent
        events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
        assert events[0]["name"] == "dbus-update-activation-environment", events
        assert not (root / "fixture.secret").exists(), "CRUD probe left a credential"
        if scenario == "owner-mismatch":
            assert not (root / "command.started").exists(), "mismatched owner must reject before command"
        else:
            assert (root / "command.finished").exists(), "wrapper interrupted the command"
            assert json.loads((root / "command.env").read_text()) == forwarded
            assert "store/read/delete verified" in combined, combined
        if scenario in ("daemon-death", "combined-failure"):
            assert "Secret Service daemon exit status: 23" in combined, combined
        if scenario == "stubborn-daemon":
            assert (root / "daemon.term").exists(), "cleanup did not attempt TERM first"
            assert "sending KILL to this shell job" in combined, combined
            assert "Secret Service daemon exit status: 137" in combined, combined
        if scenario == "interrupted-wrapper":
            assert (root / "daemon.term-before-command").exists(), "multi-job cleanup was not exercised"
        if scenario == "success":
            owner_checks = [event for event in events if any(arg.endswith(".GetNameOwner") for arg in event["args"])]
            assert len(owner_checks) >= 5, "owner was not supervised throughout command"
            assert "Secret Service isolation failed" not in combined, combined
        print(f"PASS {scenario}: exit {result.returncode}")


for case, status, diagnostic in (
    ("success", 0, None),
    ("owner-mismatch", 70, "owner PID mismatch"),
    ("owner-replacement", 70, "owner changed"),
    ("daemon-death", 70, "isolation failed"),
    ("command-failure", 37, "command/wrapper exit status: 37"),
    ("combined-failure", 37, "Secret Service daemon exit status: 23"),
    ("interrupted-wrapper", 143, "command/wrapper exit status: 143"),
    ("stubborn-daemon", 0, "sending KILL to this shell job"),
):
    contract(case, status, diagnostic)
print("8 Bash wrapper contracts passed (temporary PATH stubs; no real gnome-keyring validation).")
