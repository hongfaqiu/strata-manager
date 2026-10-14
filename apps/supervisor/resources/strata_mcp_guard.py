"""App-owned Linux MCP stdio containment; upstream files remain unchanged."""
from __future__ import annotations

import ast
import hashlib
import json
import importlib.abc
import importlib.machinery
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import threading

COMPAT_FILE = Path(__file__).with_name("observer_compat.json")


def _load_reviewed_hashes(path=COMPAT_FILE):
    """Reviewed serve/mcp.py hashes from observer_compat.json (shared with the observer)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return frozenset(h for entry in data.get("reviewed", []) for h in entry.get("mcpPySha256", [])
                         if isinstance(h, str) and len(h) == 64)
    except (OSError, ValueError, AttributeError, TypeError):
        return frozenset()


SUPPORTED_HASHES = _load_reviewed_hashes()
# The guarded start replaces upstream StdioTransport.start, so it must set exactly the
# state upstream's start sets and read only the cfg keys it forwards.
_START_ATTRIBUTES = {"proc", "_err_reader"}
_CFG_KEYS = {"env", "command", "args", "cwd"}
_REQUIRED_METHODS = {"__init__", "start", "_read", "_read_stderr", "close"}


def analyze_source(source):
    """Return (compatible, missing) for an upstream serve/mcp.py without importing it."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return False, ["parse"]
    top = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    missing = [] if "McpError" in top else ["McpError"]
    transport = top.get("StdioTransport")
    if transport is None:
        return False, missing + ["StdioTransport"]
    methods = {n.name: n for n in transport.body if isinstance(n, ast.FunctionDef)}
    missing += sorted("StdioTransport." + m for m in _REQUIRED_METHODS - methods.keys())
    for name in ("start", "_read", "_read_stderr"):
        if name in methods and ast.unparse(methods[name].args) != "self":
            missing.append(f"StdioTransport.{name} signature")
    init = methods.get("__init__")
    if init is not None and not any(isinstance(n, ast.Attribute) and n.attr == "cfg" and isinstance(n.ctx, ast.Store)
                                    for n in ast.walk(init)):
        missing.append("StdioTransport.cfg")
    start = methods.get("start")
    if start is not None:
        assigned = {n.attr for n in ast.walk(start) if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Store)
                    and isinstance(n.value, ast.Name) and n.value.id == "self"}
        missing += sorted(f"start sets self.{a}" for a in assigned - _START_ATTRIBUTES)
        keys = set()
        for n in ast.walk(start):
            if isinstance(n, ast.Subscript) and ast.unparse(n.value) == "self.cfg" and isinstance(n.slice, ast.Constant):
                keys.add(n.slice.value)
            if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get"
                    and ast.unparse(n.func.value) == "self.cfg" and n.args and isinstance(n.args[0], ast.Constant)):
                keys.add(n.args[0].value)
        missing += sorted(f"start reads cfg[{k!r}]" for k in keys - _CFG_KEYS)
    return not missing, missing


def _digest(data):
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def _patch(module, digest, helper, compatible=None):
    """compatible=None means only a reviewed digest is accepted (the fail-closed default)."""
    transport = getattr(module, "StdioTransport", None)
    if transport is None or getattr(transport, "_manager_guarded", False):
        return

    def guarded_start(self):
        if digest not in SUPPORTED_HASHES and compatible is not True:
            raise module.McpError("MCP stdio requires a supported Strata source version: this serve/mcp.py "
                                  "changed StdioTransport in a way the Strata Manager process guardian does not "
                                  "cover; update Strata Manager (HTTP MCP servers are unaffected)")
        if (not helper or not os.path.isabs(helper) or not os.path.isfile(helper)
                or not os.access(helper, os.X_OK) or not hasattr(os, "pidfd_open")):
            raise module.McpError("MCP stdio process guardian is unavailable")
        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in (self.cfg.get("env") or {}).items()})
        command = str(self.cfg["command"])
        exe = shutil.which(command, path=env.get("PATH")) or command
        parent = reader = writer = None
        process = None
        try:
            # Open in the real Strata process, not a transient creator thread.
            parent = os.pidfd_open(os.getpid(), 0)
            reader, writer = os.pipe2(os.O_CLOEXEC)
            argv = [helper, "--mcp-stdio", "--parent-pidfd", str(parent),
                    "--ready-fd", str(writer), "--", exe]
            argv.extend(str(arg) for arg in self.cfg.get("args") or [])
            process = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=self.cfg.get("cwd") or None,
                env=env, start_new_session=True, pass_fds=(parent, writer),
            )
            os.close(writer)
            writer = None
            os.close(parent)
            parent = None
            ready, _, _ = select.select([reader], [], [], 5.0)
            if not ready or os.read(reader, 1) != b"\x01":
                raise OSError("MCP guardian readiness handshake failed")
        except (OSError, ValueError, subprocess.SubprocessError):
            if process is not None:
                # Popen keeps its own unreaped child identity. Its guardian then
                # cleans the still-pinned group, without a saved-PGID kill here.
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    pass
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
            self.proc = None
            raise module.McpError("MCP stdio process guardian could not start") from None
        finally:
            for descriptor in (parent, reader, writer):
                if descriptor is not None:
                    os.close(descriptor)
        self.proc = process
        # Match upstream's original byte-stream readers and close/TERM grace.
        self._err_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._err_reader.start()
        threading.Thread(target=self._read, daemon=True).start()

    transport.start = guarded_start
    transport._manager_guarded = True


class _Loader(importlib.abc.Loader):
    def __init__(self, original, origin, helper):
        self.original, self.origin, self.helper = original, origin, helper

    def create_module(self, spec):
        return self.original.create_module(spec) if hasattr(self.original, "create_module") else None

    def exec_module(self, module):
        self.original.exec_module(module)
        digest, compatible = None, None
        try:
            path = Path(self.origin)
            if path.stat().st_size <= 1024 * 1024:
                data = path.read_bytes()
                raw = hashlib.sha256(data).hexdigest()
                digest = raw if raw in SUPPORTED_HASHES else _digest(data)
                if digest not in SUPPORTED_HASHES:
                    compatible, missing = analyze_source(data.decode("utf-8"))
                    print("[strata-manager] unreviewed serve/mcp.py: MCP stdio guard "
                          + ("applies (structural check passed)" if compatible else "refuses stdio (" + ", ".join(missing) + ")"),
                          file=sys.stderr, flush=True)
        except (OSError, TypeError, UnicodeDecodeError):
            pass
        _patch(module, digest, self.helper, compatible)


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self, helper):
        self.helper = helper

    def find_spec(self, fullname, path, target=None):
        if fullname != "serve.mcp":
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and spec.loader:
            spec.loader = _Loader(spec.loader, spec.origin, self.helper)
        return spec


def install():
    if sys.platform != "linux" or any(isinstance(item, _Finder) for item in sys.meta_path):
        return
    # Capture the app-supplied path before per-tool environment overrides exist.
    helper = os.environ.get("STRATA_MANAGER_MCP_HELPER")
    sys.meta_path.insert(0, _Finder(helper))
