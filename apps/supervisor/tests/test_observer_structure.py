"""Structural capability detection against real upstream serve/server.py sources.

Every reviewed entry in observer_compat.json is downloaded by its pinned ref
(cached in .reference/server-py), its hash is verified, and analyze_source must
classify it as fully observable. Set STRATA_REQUIRE_FIXTURES=1 to fail rather
than skip when offline, and STRATA_CHECK_UPSTREAM_MAIN=1 to also check the
upstream main branch (a sentinel for the next release).
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request

RESOURCES = Path(__file__).resolve().parents[1] / "resources"
sys.path.insert(0, str(RESOURCES))
import strata_observer as observer

CACHE = Path(__file__).resolve().parents[3] / ".reference" / "server-py"
COMPAT = json.loads((RESOURCES / "observer_compat.json").read_text(encoding="utf-8"))
REQUIRE = os.environ.get("STRATA_REQUIRE_FIXTURES") == "1"


def fetch(ref):
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / f"{ref}.py"
    if not target.is_file() or ref == "main":
        url = f"https://raw.githubusercontent.com/Niko1221/Strata/{ref}/serve/server.py"
        with urllib.request.urlopen(url, timeout=60) as response:
            target.write_bytes(response.read())
    return target.read_bytes()


def canonical(data):
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


class ReviewedSources(unittest.TestCase):
    def test_every_reviewed_source_is_structurally_observable(self):
        for entry in COMPAT["reviewed"]:
            with self.subTest(version=entry["version"]):
                try:
                    data = fetch(entry["ref"])
                except OSError as error:
                    if REQUIRE:
                        raise
                    self.skipTest(f"upstream fixture unavailable: {error}")
                self.assertIn(canonical(data), entry["serverPySha256"], "pinned ref no longer matches its reviewed hash")
                result = observer.analyze_source(data.decode("utf-8"))
                self.assertEqual(result["mode"], "structural", result)
                self.assertEqual(result["missing"], [])

    @unittest.skipUnless(os.environ.get("STRATA_CHECK_UPSTREAM_MAIN") == "1", "upstream main sentinel is opt-in")
    def test_upstream_main_keeps_the_core_contract(self):
        result = observer.analyze_source(fetch("main").decode("utf-8"))
        self.assertNotEqual(result["mode"], "disabled", result)


class SyntheticSources(unittest.TestCase):
    """Mutations of a minimal faithful contract, independent of the network."""
    BASE = '''
ROUTES = ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"]
def request_stats(segments): pass
def run_with_mcp(*a, **k): pass
class Service:
    def run(self, ids, thinking, tools, max_new, sampling, cancel, force=None): pass
    def _note(self, n, evs, st=None, rate=None): pass
    def begin_request(self, path, req): pass
    def ensure_loaded(self): pass
    def metrics(self, all_requests=False): pass
def make_handler(svc):
    class H:
        def do_POST(self): pass
        def do_GET(self): pass
        def send_response(self, code, message=None): pass
        def _note(self, **values): pass
        def _json(self, code, obj, headers=None): pass
        def _capture(self, items, api): pass
    return H
'''

    def test_full_contract_is_structural(self):
        self.assertEqual(observer.analyze_source(self.BASE)["mode"], "structural")

    def test_missing_optional_capabilities_degrade_individually(self):
        source = self.BASE.replace("def request_stats", "def renamed_stats").replace("def run_with_mcp", "def other")
        result = observer.analyze_source(source)
        self.assertEqual(result["mode"], "partial")
        self.assertEqual(result["capabilities"], {"core": True, "load_state": True, "expert_stats": False, "mcp": False})

    def test_changed_core_signature_disables(self):
        for old, new in (("cancel, force=None", "cancel"), ("def _capture(self, items, api)", "def _capture(self, items)"),
                         ("def begin_request", "def start_request"), ('"/v1/responses"', '"/v2/responses"')):
            with self.subTest(change=new):
                result = observer.analyze_source(self.BASE.replace(old, new))
                self.assertEqual(result["mode"], "disabled")
                self.assertFalse(result["capabilities"]["core"])

    def test_020_retry_after_json_signature_is_structural(self):
        # Strata 0.2.0 adds retry_after=None to Handler._json for 429/503.
        source = self.BASE.replace("def _json(self, code, obj, headers=None)",
                                   "def _json(self, code, obj, headers=None, retry_after=None)")
        self.assertEqual(observer.analyze_source(source)["mode"], "structural")
        unknown = self.BASE.replace("def _json(self, code, obj, headers=None)",
                                    "def _json(self, code, obj, headers=None, retry_after=None, extra=None)")
        self.assertEqual(observer.analyze_source(unknown)["mode"], "disabled")

    def test_unparsable_source_disables(self):
        self.assertEqual(observer.analyze_source("def (:")["mode"], "disabled")

    def test_compat_file_is_the_hash_source(self):
        expected = {h for e in COMPAT["reviewed"] for h in e["serverPySha256"]}
        self.assertEqual(set(observer.SUPPORTED_HASHES), expected)
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(observer._load_reviewed_hashes(Path(temp) / "missing.json"), frozenset())
            bad = Path(temp) / "bad.json"
            bad.write_text("{not json", encoding="utf-8")
            self.assertEqual(observer._load_reviewed_hashes(bad), frozenset())


class InstrumentModes(unittest.TestCase):
    def namespace(self):
        ns = {}
        exec(SyntheticSources.BASE, ns)
        return ns

    def instrument(self, analysis, digest="0" * 64):
        ns = self.namespace()
        before = {k: ns[k] for k in ("request_stats", "run_with_mcp")}
        before["metrics"] = ns["Service"].metrics
        with tempfile.TemporaryDirectory() as temp:
            journal = observer.Journal(temp, "modes")
            try:
                observer.instrument_globals(ns, journal=journal, source_hash=digest, analysis=analysis)
                status = json.loads(journal.status_path.read_text(encoding="utf-8"))
            finally:
                journal.close()
        return ns, before, status

    def test_partial_mode_wraps_only_present_capabilities(self):
        analysis = {"mode": "partial", "capabilities": {"core": True, "load_state": False, "expert_stats": True, "mcp": False}}
        ns, before, status = self.instrument(analysis)
        self.assertTrue(ns.get("_strata_manager_instrumented"))
        self.assertIs(ns["run_with_mcp"], before["run_with_mcp"])
        self.assertIs(ns["Service"].metrics, before["metrics"])
        self.assertIsNot(ns["request_stats"], before["request_stats"])
        self.assertEqual((status["supported"], status["observerMode"]), (True, "partial"))

    def test_disabled_analysis_leaves_upstream_untouched(self):
        ns, before, status = self.instrument({"mode": "disabled", "capabilities": {"core": False}})
        self.assertFalse(ns.get("_strata_manager_instrumented"))
        self.assertIs(ns["request_stats"], before["request_stats"])
        self.assertEqual((status["supported"], status["error"], status["observerMode"]), (False, "unsupported_runtime", "disabled"))

    def test_unknown_source_without_analysis_is_disabled(self):
        ns, _, status = self.instrument(None)
        self.assertFalse(ns.get("_strata_manager_instrumented"))
        self.assertEqual(status["observerMode"], "disabled")

    def test_reviewed_hash_is_the_fast_path(self):
        ns, _, status = self.instrument(None, digest=next(iter(observer.SUPPORTED_HASHES)))
        self.assertTrue(ns.get("_strata_manager_instrumented"))
        self.assertEqual(status["observerMode"], "reviewed")

    def _json_calls(self, signature):
        ns = {}
        exec(SyntheticSources.BASE.replace("def _json(self, code, obj, headers=None): pass",
             "def _json(" + signature + "): CALLS.append(dict(locals()))"), ns)
        ns["CALLS"] = calls = []
        with tempfile.TemporaryDirectory() as temp:
            journal = observer.Journal(temp, "json")
            try:
                observer.instrument_globals(ns, journal=journal, source_hash="1" * 64,
                                            analysis=observer.analyze_source(SyntheticSources.BASE))
            finally:
                journal.close()
        return ns["make_handler"](object()), calls

    def test_json_forwards_only_arguments_the_upstream_caller_supplied(self):
        handler, calls = self._json_calls("self, code, obj, headers=None, retry_after=None")
        instance = handler.__new__(handler)
        handler._json(instance, 429, {"error": {}}, retry_after=1)
        handler._json(instance, 503, {"error": {}}, headers={"Retry-After": "2"})
        handler._json(instance, 200, {})
        self.assertEqual([(c["code"], c["headers"], c["retry_after"]) for c in calls],
                         [(429, None, 1), (503, {"Retry-After": "2"}, None), (200, None, None)])
        # Pre-0.1.43.1 handlers take only (code, obj): never pass optional keywords to them.
        old, old_calls = self._json_calls("self, code, obj")
        old._json(old.__new__(old), 200, {})
        self.assertEqual([c["code"] for c in old_calls], [200])

    def test_loader_injects_structural_analysis_for_unreviewed_source(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "server.py"
            path.write_text(SyntheticSources.BASE + "\nif __name__ == '__main__':\n    pass\n", encoding="utf-8")

            class Plain:
                def get_source(self, name): return path.read_text(encoding="utf-8")
                def get_filename(self, name): return str(path)
            journal = observer.Journal(temp, "loader")
            previous, observer._journal = observer._journal, journal
            try:
                ns = {"__name__": "serve.server"}
                exec(observer._ObservedLoader(Plain(), "serve.server").get_code("serve.server"), ns)
                status = json.loads(journal.status_path.read_text(encoding="utf-8"))
            finally:
                observer._journal = previous
                journal.close()
        self.assertTrue(ns.get("_strata_manager_instrumented"))
        self.assertEqual(status["observerMode"], "structural")


if __name__ == "__main__":
    unittest.main(verbosity=2)
