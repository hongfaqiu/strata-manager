"""Fail-closed adapter checks; native Linux lifecycle is tested by mcp_stdio.rs."""
import hashlib
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources"))
import strata_mcp_guard as guard


def module():
    class Transport:
        def start(self):
            raise AssertionError("unguarded original start must not run")
    return types.SimpleNamespace(StdioTransport=Transport, McpError=RuntimeError,
                                 HttpTransport=object())


class GuardContract(unittest.TestCase):
    def test_pinned_upstream_hash_is_supported(self):
        upstream = Path(os.environ["STRATA_TEST_ROOT"])
        digest = hashlib.sha256((upstream / "serve/mcp.py").read_bytes()).hexdigest()
        self.assertIn(digest, guard.SUPPORTED_HASHES)

    def test_unknown_source_refuses_stdio_without_spawning_or_altering_http(self):
        source = module()
        http = source.HttpTransport
        guard._patch(source, "unknown-source", sys.executable)
        transport = source.StdioTransport()
        with patch.object(guard.subprocess, "Popen", side_effect=AssertionError("must not spawn")):
            with self.assertRaisesRegex(RuntimeError, "supported Strata source"):
                transport.start()
        self.assertIs(source.HttpTransport, http)

    def test_missing_helper_refuses_instead_of_unguarded_fallback(self):
        source = module()
        guard._patch(source, next(iter(guard.SUPPORTED_HASHES)), "/nonexistent/manager-helper")
        with patch.object(guard.subprocess, "Popen", side_effect=AssertionError("must not spawn")):
            with self.assertRaisesRegex(RuntimeError, "guardian is unavailable"):
                source.StdioTransport().start()

    def test_install_is_idempotent_and_only_intercepts_exact_upstream_module(self):
        previous = list(sys.meta_path)
        try:
            with patch.object(guard.sys, "platform", "linux"):
                with patch.dict(os.environ, {"STRATA_MANAGER_MCP_HELPER": sys.executable}):
                    guard.install()
                with patch.dict(os.environ, {"STRATA_MANAGER_MCP_HELPER": "/ignored/late-override"}):
                    guard.install()
            finders = [item for item in sys.meta_path if isinstance(item, guard._Finder)]
            self.assertEqual(len(finders), 1)
            self.assertEqual(finders[0].helper, sys.executable)
            self.assertIsNone(finders[0].find_spec("other.mcp", []))
            self.assertIsNone(finders[0].find_spec("serve.server", []))
        finally:
            sys.meta_path[:] = previous


if __name__ == "__main__":
    unittest.main(verbosity=2)
