"""Public /health, /status and /metrics contracts of the real upstream MockEngine.

These are the fallback observation channel when the observer is disabled, so
they are tested without the observer installed. STRATA_TEST_ROOT selects the
upstream checkout (default .reference/strata). With STRATA_WRITE_PUBLIC_FIXTURE=1
the captured responses are written to packages/core/tests/fixtures for the
TypeScript parser tests; otherwise the committed fixture's shape is enforced.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.request

REPO = Path(__file__).resolve().parents[3]
ROOT = Path(os.environ.get("STRATA_TEST_ROOT", str(REPO / ".reference" / "strata")))
FIXTURE = REPO / "packages/core/tests/fixtures/public-endpoints.json"
sys.path.insert(0, str(ROOT))
try:
    from serve import server
    from serve.frontend import ChatTemplate
except ImportError as error:  # pragma: no cover - depends on the checkout
    raise unittest.SkipTest(f"upstream checkout unavailable: {error}")


def shape(value):
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__


def subset(expected, actual, path="$"):
    """Every key the parser relies on (the fixture) must still exist with the same JSON type."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), path
        for key, value in expected.items():
            assert key in actual, f"{path}.{key} missing"
            subset(value, actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list), path
        if expected and actual:
            subset(expected[0], actual[0], path + "[0]")
    elif expected != "NoneType" and actual != "NoneType":
        numeric = {"int", "float"}
        assert expected == actual or {expected, actual} <= numeric, f"{path}: {expected} -> {actual}"


class PublicEndpoints(unittest.TestCase):
    def setUp(self):
        tok = server.ByteTokenizer()
        self.engine = server.MockEngine(tok, "</think>\n\n" + "public fixture reply " * 8, max_context=32768, delay_s=0.05)
        self.svc = server.Service(self.engine, tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        self.httpd = server.serve(self.svc, port=0)
        self.base = "http://127.0.0.1:" + str(self.httpd.server_address[1])

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=10) as response:
            return json.loads(response.read())

    def test_public_channel_contract(self):
        captured = {"health": self.get("/health"), "statusIdle": self.get("/status"), "metrics": self.get("/metrics")}
        self.assertEqual((captured["health"]["service"], captured["health"]["status"]), ("strata", "ok"))
        self.assertIn("loaded", captured["health"])
        self.assertFalse(captured["statusIdle"].get("busy", False))
        body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 64}).encode()
        request = urllib.request.Request(self.base + "/v1/chat/completions", data=body, headers={"Content-Type": "application/json"})
        worker = threading.Thread(target=lambda: urllib.request.urlopen(request, timeout=30).read())
        worker.start()
        busy = None
        for _ in range(200):
            value = self.get("/status")
            if value.get("busy"):
                busy = value
                break
            time.sleep(0.01)
        worker.join(30)
        self.assertIsNotNone(busy, "/status never reported busy during a generation")
        captured["statusBusy"] = busy
        self.assertIsInstance(busy.get("elapsed_s"), (int, float))
        if os.environ.get("STRATA_WRITE_PUBLIC_FIXTURE") == "1":
            FIXTURE.parent.mkdir(parents=True, exist_ok=True)
            FIXTURE.write_text(json.dumps({"source": f"upstream MockEngine at {ROOT.name}", **captured}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        else:
            expected = json.loads(FIXTURE.read_text(encoding="utf-8"))
            for key in ("health", "statusIdle", "statusBusy", "metrics"):
                subset(shape(expected[key]), shape(captured[key]), key)


if __name__ == "__main__":
    unittest.main(verbosity=2)
