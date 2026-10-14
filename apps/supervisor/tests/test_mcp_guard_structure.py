"""Reviewed-or-structural rule of the Linux MCP stdio guard against real upstream serve/mcp.py.

Each reviewed ref in observer_compat.json is fetched (cached in .reference/mcp-py) and must
match its reviewed hash and pass the structural check; mutations must be refused.
STRATA_REQUIRE_FIXTURES=1 fails instead of skipping offline; STRATA_CHECK_UPSTREAM_MAIN=1
also checks upstream main.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys
import types
import unittest
import urllib.request
from unittest.mock import patch

RESOURCES = Path(__file__).resolve().parents[1] / "resources"
sys.path.insert(0, str(RESOURCES))
import strata_mcp_guard as guard

CACHE = Path(__file__).resolve().parents[3] / ".reference" / "mcp-py"
COMPAT = json.loads((RESOURCES / "observer_compat.json").read_text(encoding="utf-8"))
REQUIRE = os.environ.get("STRATA_REQUIRE_FIXTURES") == "1"


def fetch(ref):
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / f"{ref}.py"
    if not target.is_file() or ref == "main":
        with urllib.request.urlopen(f"https://raw.githubusercontent.com/Niko1221/Strata/{ref}/serve/mcp.py", timeout=60) as r:
            target.write_bytes(r.read())
    return target.read_bytes()


def base_source():
    try:
        return fetch(COMPAT["reviewed"][-1]["ref"]).decode("utf-8")
    except OSError as error:
        if REQUIRE:
            raise
        raise unittest.SkipTest(f"upstream fixture unavailable: {error}")


class RealSources(unittest.TestCase):
    def test_reviewed_sources_match_hash_and_structure(self):
        for entry in COMPAT["reviewed"]:
            with self.subTest(version=entry["version"]):
                try:
                    data = fetch(entry["ref"])
                except OSError as error:
                    if REQUIRE:
                        raise
                    self.skipTest(str(error))
                self.assertIn(guard._digest(data), entry["mcpPySha256"])
                self.assertIn(guard._digest(data), guard.SUPPORTED_HASHES)
                self.assertEqual(guard.analyze_source(data.decode("utf-8")), (True, []))

    @unittest.skipUnless(os.environ.get("STRATA_CHECK_UPSTREAM_MAIN") == "1", "opt-in sentinel")
    def test_upstream_main_is_structurally_guardable(self):
        self.assertTrue(guard.analyze_source(fetch("main").decode("utf-8"))[0])


class Mutations(unittest.TestCase):
    def test_contract_changes_are_refused(self):
        source = base_source()
        cases = {
            "renamed reader": ("def _read_stderr(self)", "def _drain_stderr(self)"),
            "new start state": ("self._err_reader = threading.Thread", "self._extra = 1\n        self._err_reader = threading.Thread"),
            "new cfg key": ('self.cfg.get("cwd")', 'self.cfg.get("workdir")'),
            "missing error": ("class McpError", "class McpFailure"),
        }
        for name, (old, new) in cases.items():
            with self.subTest(name):
                self.assertIn(old, source, name)
                ok, missing = guard.analyze_source(source.replace(old, new, 1))
                self.assertFalse(ok)
                self.assertTrue(missing)
        self.assertEqual(guard.analyze_source("def (:"), (False, ["parse"]))

    def test_unrelated_change_stays_guardable(self):
        self.assertEqual(guard.analyze_source(base_source() + "\n# unrelated upstream comment\n"), (True, []))


class PatchRule(unittest.TestCase):
    def module(self):
        class Transport:
            def start(self):
                raise AssertionError("unguarded original start must not run")
        return types.SimpleNamespace(StdioTransport=Transport, McpError=RuntimeError)

    def test_structural_pass_reaches_the_guardian_and_failure_refuses_clearly(self):
        allowed = self.module()
        guard._patch(allowed, "0" * 64, "/nonexistent/helper", compatible=True)
        with patch.object(guard.subprocess, "Popen", side_effect=AssertionError("must not spawn")):
            with self.assertRaisesRegex(RuntimeError, "guardian is unavailable"):
                allowed.StdioTransport().start()
        refused = self.module()
        guard._patch(refused, "0" * 64, "/nonexistent/helper", compatible=False)
        with self.assertRaisesRegex(RuntimeError, "update Strata Manager"):
            refused.StdioTransport().start()

    def test_hashes_come_from_the_shared_compat_file(self):
        expected = {h for e in COMPAT["reviewed"] for h in e["mcpPySha256"]}
        self.assertEqual(set(guard.SUPPORTED_HASHES), expected)
        self.assertEqual(guard._load_reviewed_hashes(Path("/nonexistent.json")), frozenset())


if __name__ == "__main__":
    unittest.main(verbosity=2)
