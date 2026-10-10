"""App-owned Linux MCP stdio containment; upstream files remain unchanged."""
from __future__ import annotations

import hashlib
import importlib.abc
import importlib.machinery
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import threading

SUPPORTED_HASHES = {
    # Fixed Strata 0.1.41: LF and equivalent Windows CRLF source bytes.
    "659c8e3c7db7d51c939870f843b2350f3efcf2ce8f1ff4b4372db4631e39b77f",
    "e7440cf7d404f2a9d9ff44c7bb9768c3a6abf0f036bc222e17beaed65aabba06",
}


def _patch(module, digest, helper):
    transport = getattr(module, "StdioTransport", None)
    if transport is None or getattr(transport, "_manager_guarded", False):
        return

    def guarded_start(self):
        if digest not in SUPPORTED_HASHES:
            raise module.McpError("MCP stdio requires a supported Strata source version")
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
        digest = None
        try:
            path = Path(self.origin)
            if path.stat().st_size <= 1024 * 1024:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except (OSError, TypeError):
            pass
        _patch(module, digest, self.helper)


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
