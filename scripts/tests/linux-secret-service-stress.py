#!/usr/bin/env python3
"""Exercise real OpenSession lifetimes without reading or writing credentials.

Run with /usr/bin/python3 inside scripts/release-linux-tests.sh. Every probe
uses a private connection and sends OpenSession directly to the original unique
owner: no Introspect, availability warm-up, replacement activation, or retry.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import sys
import threading
import time


SERVICE = "org.freedesktop.Secret.Service"
SESSION = "org.freedesktop.Secret.Session"
SERVICE_PATH = "/org/freedesktop/secrets"
BUS_NAME = "org.freedesktop.DBus"
BUS_PATH = "/org/freedesktop/DBus"
SINGLE_ITERATIONS = 1000
PARALLEL_THREADS = 16
ITERATIONS_PER_THREAD = 200


@dataclass(frozen=True)
class Identity:
    owner: str
    pid: int
    start_ticks: str


@dataclass
class Totals:
    attempted: int = 0
    succeeded: int = 0
    failed: int = 0
    sessions_closed: int = 0
    connections_closed: int = 0
    unique_names: set = field(default_factory=set)
    errors: list = field(default_factory=list)

    def merge(self, other):
        for name in ("attempted", "succeeded", "failed", "sessions_closed",
                     "connections_closed"):
            setattr(self, name, getattr(self, name) + getattr(other, name))
        self.unique_names.update(other.unique_names)
        self.errors.extend(other.errors[:max(0, 20 - len(self.errors))])

    def report(self, requested, elapsed):
        return {
            "requested": requested,
            "attempted": self.attempted,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "sessions_closed": self.sessions_closed,
            "connections_closed": self.connections_closed,
            "unique_connections": len(self.unique_names),
            "elapsed_seconds": round(elapsed, 3),
            "errors": self.errors,
        }


def remaining_timeout(deadline, call_timeout):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Overall stress-test deadline exceeded")
    return min(call_timeout, remaining)


def process_start_ticks(pid):
    os.kill(pid, 0)
    stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    end = stat.rfind(")")
    fields = stat[end + 2:].split() if end >= 0 else []
    if len(fields) < 20 or fields[0] in ("Z", "X", "x"):
        raise RuntimeError("Original Secret Service daemon is absent or not alive")
    if not fields[19].isdigit():
        raise RuntimeError("Unexpected original daemon process start time")
    return fields[19]


def read_identity(dbus, deadline, call_timeout, expected_owner, expected_pid):
    # All these calls go to the bus daemon, never to the service alias.
    bus = dbus.SessionBus(private=True)
    try:
        def bus_call(method, argument):
            return bus.call_blocking(
                BUS_NAME, BUS_PATH, BUS_NAME, method, "s", (argument,),
                timeout=remaining_timeout(deadline, call_timeout),
            )

        owner = str(bus_call("GetNameOwner", "org.freedesktop.secrets"))
        if not re.fullmatch(r":[0-9]+\.[0-9]+", owner):
            raise RuntimeError(f"Unexpected Secret Service unique owner: {owner!r}")
        if owner != expected_owner:
            raise RuntimeError(f"Secret Service owner changed: {expected_owner} -> {owner}")
        pid = int(bus_call("GetConnectionUnixProcessID", owner))
        if pid <= 0 or pid != expected_pid:
            raise RuntimeError(f"Secret Service owner PID mismatch: expected {expected_pid}, got {pid}")
        start_ticks = process_start_ticks(pid)
        if str(bus_call("GetNameOwner", "org.freedesktop.secrets")) != owner:
            raise RuntimeError("Secret Service owner changed during identity verification")
        return Identity(owner, pid, start_ticks)
    finally:
        bus.close()


def check_identity(dbus, identity, deadline, call_timeout):
    actual = read_identity(dbus, deadline, call_timeout, identity.owner, identity.pid)
    if actual != identity:
        raise RuntimeError("Original Secret Service daemon PID was reused")


def probe(dbus, identity, deadline, call_timeout):
    bus = None
    session_path = None
    unique_name = None
    session_closed = False
    connection_closed = False
    errors = []
    try:
        bus = dbus.SessionBus(private=True)
        # This must be the first service call on this connection. Using
        # call_blocking with an explicit signature avoids proxy Introspect.
        reply = bus.call_blocking(
            identity.owner, SERVICE_PATH, SERVICE, "OpenSession", "sv",
            (dbus.String("plain"), dbus.String("", variant_level=1)),
            timeout=remaining_timeout(deadline, call_timeout),
        )
        unique_name = str(bus.get_unique_name())
        if not isinstance(reply, (tuple, list)) or len(reply) != 2:
            raise RuntimeError("OpenSession did not return its two required values")
        output, returned_path = reply
        if isinstance(returned_path, dbus.ObjectPath) and str(returned_path) != "/":
            session_path = returned_path
        else:
            raise RuntimeError("OpenSession returned an empty or invalid session path")
        # The plain algorithm legitimately returns an EMPTY string inside a
        # non-null variant; requiring non-empty text would reject valid replies.
        if (not isinstance(output, dbus.String) or str(output) != ""
                or output.variant_level != 1):
            raise RuntimeError("OpenSession returned an invalid plain output variant")
    except Exception as error:
        errors.append(f"OpenSession: {type(error).__name__}: {error}")
    finally:
        if bus is not None:
            if unique_name is None:
                try:
                    unique_name = str(bus.get_unique_name())
                except Exception as error:
                    errors.append(f"Connection identity: {type(error).__name__}: {error}")
            if session_path is not None:
                try:
                    reply = bus.call_blocking(
                        identity.owner, session_path, SESSION, "Close", "", (),
                        timeout=call_timeout,
                    )
                    if reply is not None and reply != ():
                        raise RuntimeError("Session.Close returned an unexpected response")
                    session_closed = True
                except Exception as error:
                    errors.append(f"Session.Close: {type(error).__name__}: {error}")
            try:
                bus.close()
                if bus.get_is_connected():
                    raise RuntimeError("Private connection remained open after close")
                connection_closed = True
            except Exception as error:
                errors.append(f"Connection.close: {type(error).__name__}: {error}")
    return unique_name, session_closed, connection_closed, errors


def worker(dbus, identity, count, deadline, call_timeout, stop, barrier=None):
    totals = Totals()
    if barrier is not None:
        try:
            barrier.wait(timeout=remaining_timeout(deadline, 10.0))
        except Exception as error:
            stop.set()
            totals.errors.append(f"Worker start: {type(error).__name__}: {error}")
            return totals
    for index in range(count):
        if stop.is_set():
            break
        name, closed, disconnected, errors = probe(dbus, identity, deadline, call_timeout)
        totals.attempted += 1
        totals.sessions_closed += int(closed)
        totals.connections_closed += int(disconnected)
        if name is not None:
            if name in totals.unique_names:
                errors.append("A private connection reused an earlier unique name")
            totals.unique_names.add(name)
        if errors:
            totals.failed += 1
            if len(totals.errors) < 20:
                totals.errors.append({"iteration": index + 1, "errors": errors})
            stop.set()
            break
        totals.succeeded += 1
    return totals


def run_phase(dbus, identity, threads, iterations, deadline, call_timeout):
    check_identity(dbus, identity, deadline, call_timeout)
    started = time.monotonic()
    stop = threading.Event()
    totals = Totals()
    if threads == 1:
        totals = worker(dbus, identity, iterations, deadline, call_timeout, stop)
    else:
        barrier = threading.Barrier(threads)
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = [executor.submit(worker, dbus, identity, iterations, deadline,
                                       call_timeout, stop, barrier) for _ in range(threads)]
            try:
                for future in futures:
                    totals.merge(future.result())
            finally:
                stop.set()
    requested = threads * iterations
    report = totals.report(requested, time.monotonic() - started)
    try:
        check_identity(dbus, identity, deadline, call_timeout)
        report["original_daemon_alive"] = True
    except Exception as error:
        report["original_daemon_alive"] = False
        report["errors"].append(f"Post-phase identity: {type(error).__name__}: {error}")
    report["ok"] = (
        totals.succeeded == requested and totals.failed == 0
        and totals.sessions_closed == requested and totals.connections_closed == requested
        and len(totals.unique_names) == requested and not report["errors"]
        and report["original_daemon_alive"]
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", default=os.environ.get("STRATA_TEST_KEYRING_OWNER"))
    parser.add_argument("--pid", type=int, default=os.environ.get("STRATA_TEST_KEYRING_PID"))
    parser.add_argument("--call-timeout", type=float, default=2.0)
    parser.add_argument("--deadline-seconds", type=float, default=100.0)
    args = parser.parse_args()
    started = time.monotonic()
    report = {
        "schema": "strata-secret-service-stress/v1", "ok": False,
        "planned": {"single": SINGLE_ITERATIONS, "parallel_threads": PARALLEL_THREADS,
                    "iterations_per_thread": ITERATIONS_PER_THREAD},
        "phases": {}, "errors": [],
    }
    try:
        if sys.platform != "linux" or not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
            raise RuntimeError("Run on Linux inside the isolated release-linux-tests.sh bus")
        if (not args.owner or not re.fullmatch(r":[0-9]+\.[0-9]+", args.owner)
                or args.pid is None or args.pid <= 0):
            raise ValueError("Original unique owner and positive PID are required via wrapper metadata or --owner/--pid")
        if not (0 < args.call_timeout <= 10 and 0 < args.deadline_seconds <= 600):
            raise ValueError("Call timeout must be 0..10s and overall deadline 0..600s")
        import dbus
        from dbus.mainloop.glib import threads_init

        threads_init()
        deadline = started + args.deadline_seconds
        identity = read_identity(dbus, deadline, args.call_timeout, args.owner, args.pid)
        report["original_daemon"] = {
            "owner": identity.owner, "pid": identity.pid, "start_ticks": identity.start_ticks,
        }
        for name, threads, iterations in (
            ("single", 1, SINGLE_ITERATIONS),
            ("parallel", PARALLEL_THREADS, ITERATIONS_PER_THREAD),
        ):
            phase = run_phase(dbus, identity, threads, iterations, deadline, args.call_timeout)
            report["phases"][name] = phase
            if not phase["ok"]:
                raise RuntimeError(f"{name} phase failed; remaining probes were not retried")
        check_identity(dbus, identity, deadline, args.call_timeout)
        report["ok"] = True
    except Exception as error:
        report["errors"].append(f"{type(error).__name__}: {error}")
    report["elapsed_seconds"] = round(time.monotonic() - started, 3)
    print(json.dumps(report, sort_keys=True), flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
