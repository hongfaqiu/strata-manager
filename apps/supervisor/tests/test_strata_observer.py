"""Real loopback HTTP tests against upstream's MockEngine (no weights/GPU).

Place the verified upstream checkout in .reference/strata, then run:
    python apps/supervisor/tests/test_strata_observer.py
STRATA_TEST_ROOT may override that project-relative checkout path.
The upstream checkout is read-only throughout these tests.
"""
from __future__ import annotations
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(os.environ.get("STRATA_TEST_ROOT", str(Path(__file__).resolve().parents[3] / ".reference" / "strata")))
RESOURCE = Path(__file__).resolve().parents[1] / "resources/strata_observer.py"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(RESOURCE.parent))
import strata_observer as observer
from serve import server
from serve.frontend import ChatTemplate
from serve.mcp import McpHub

SOURCE_HASH = hashlib.sha256((ROOT / "serve/server.py").read_bytes().replace(b"\r\n", b"\n")).hexdigest()
OFFICIAL_0142_HASH = "ce9266730b632e919ff93809ea6f9ecd6f91f12da19597a2d95a7edb29700dfa"
OFFICIAL_0143_HASH = "55ee9d1160f0da457cabe6f9dfea9884296b6d70fd3d14abd4ed42e6f79dd72b"
OFFICIAL_01431_HASH = "6046f030abca250fd09f9a4fc95f5bb764d8420754acce049db2e4db77335bad"
OFFICIAL_0144_HASH = "2aa0d2060766799be2ea7045dc13ca5bab2cec39ad5c29bc8a54d816ed246e7c"
OFFICIAL_01441_HASH = "6c45c639e28a873b854606719d9ce2bb2e0df666f105164e78e2735878b9aa8f"
KEEP_AWAKE_SOURCE_HASHES = {OFFICIAL_0142_HASH, OFFICIAL_0143_HASH, OFFICIAL_01431_HASH, OFFICIAL_0144_HASH, OFFICIAL_01441_HASH}
NONFINITE_SOURCE_HASHES = {OFFICIAL_0143_HASH, OFFICIAL_01431_HASH, OFFICIAL_0144_HASH, OFFICIAL_01441_HASH}
HEADER_JSON_SOURCE_HASHES = {OFFICIAL_01431_HASH, OFFICIAL_0144_HASH, OFFICIAL_01441_HASH}
RETRYABLE_503_SOURCE_HASHES = {OFFICIAL_01431_HASH, OFFICIAL_0144_HASH, OFFICIAL_01441_HASH}


class BlockingLazyEngine(server.MockEngine):
    """A real upstream MockEngine with a controllable, CPU-only reload."""
    def __init__(self, tokenizer, failure=None):
        super().__init__(tokenizer, "</think>\n\nfixture reply", max_context=32768)
        self.unloaded = False
        self.load_entered, self.load_release = threading.Event(), threading.Event()
        self.restarts = 0
        self.failure = failure

    def alive(self):
        return not self.unloaded

    def unload(self):
        self.unloaded = True

    def restart(self):
        self.restarts += 1
        self.load_entered.set()
        if not self.load_release.wait(5):
            raise RuntimeError("fixture load was not released")
        if self.failure is not None:
            raise self.failure
        self.unloaded = False


class ObserverHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="strata-observer-http-")
        cls.journal = observer.Journal(cls.temp.name, "fixture")
        digest = SOURCE_HASH
        if digest not in observer.SUPPORTED_HASHES:
            raise unittest.SkipTest("the checkout isn't a verified observer runtime")
        observer.instrument_globals(vars(server), journal=cls.journal, source_hash=digest)

    @classmethod
    def tearDownClass(cls):
        cls.journal.close()
        cls.temp.cleanup()

    def setUp(self):
        self.cursor = self.journal.db.execute("SELECT COALESCE(MAX(seq),0) FROM events").fetchone()[0]
        self.httpd = None
        self.hub = None

    def tearDown(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        if self.hub:
            self.hub.close()

    def start(self, script="</think>\n\nfixture reply", delay=0, engine=None):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        tok = server.ByteTokenizer()
        self.engine = engine or server.MockEngine(tok, script, max_context=32768, delay_s=delay)
        self.svc = server.Service(self.engine, tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        if self.hub:
            self.svc.mcp = self.hub
        self.httpd = server.serve(self.svc, port=0)
        self.base = "http://127.0.0.1:" + str(self.httpd.server_address[1])

    def post(self, path, payload, headers=None, raw=None):
        return self.post_response(path, payload, headers, raw)[:2]

    def post_response(self, path, payload, headers=None, raw=None):
        req = urllib.request.Request(self.base + path, data=raw if raw is not None else json.dumps(payload).encode(),
              headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read().decode(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode(), dict(error.headers)

    def events(self, kind=None):
        # Give the handler's finally block time to commit after HTTP body flush.
        time.sleep(0.03)
        rows = self.journal.db.execute("SELECT kind,payload FROM events WHERE seq>? ORDER BY seq", (self.cursor,)).fetchall()
        return [json.loads(payload) for name, payload in rows if not kind or name == kind]

    def test_three_protocols_stream_and_collect_preserve_usage(self):
        self.start()
        paths = [("/v1/chat/completions", {"model":"m", "messages":[{"role":"user","content":"PRIVATE_PROMPT_123"}]}),
                 ("/v1/responses", {"model":"m", "input":"PRIVATE_PROMPT_123"}),
                 ("/v1/messages", {"model":"m", "messages":[{"role":"user","content":"PRIVATE_PROMPT_123"}]})]
        for path, body in paths:
            for stream in (False, True):
                status, text = self.post(path, {**body, "max_tokens":64, "stream":stream},
                                         {"X-Strata-Client":"test.desktop", "User-Agent":"PRIVATE_UA_123"})
                self.assertEqual(status, 200, text)
                if stream:
                    self.assertIn("data:", text)
                else:
                    self.assertIn("usage", json.loads(text))
        ends = self.events("request_end")
        self.assertEqual(len(ends), 6)
        self.assertEqual({e["route"] for e in ends}, {"chat","responses","anthropic"})
        self.assertTrue(all(e["outcome"] == "succeeded" for e in ends))
        self.assertTrue(all(e["inputTokens"] > 0 and e["outputTokens"] > 0 for e in ends))
        self.assertTrue(all(e["firstTokenS"] is not None for e in ends))
        self.assertEqual(sum(e["stream"] for e in ends), 3)
        runs = self.events("run_end")
        self.assertEqual(len(runs), 6)
        self.assertEqual({r["requestId"] for r in runs}, {r["requestId"] for r in ends})
        # MockEngine has no engine timings; fabricated decode speed is forbidden.
        self.assertTrue(all(r["decodeTokS"] is None for r in runs))
        self.assertTrue(all(r["prefillTokS"] is None and r["prefillS"] is None for r in runs))
        saved = json.dumps(self.events())
        for private in ("PRIVATE_PROMPT_123","PRIVATE_UA_123","fixture reply","Authorization","messages"):
            self.assertNotIn(private, saved)

    def test_real_http_preserves_engine_prefill_cache_and_decode_timings(self):
        class Timed(server.MockEngine):
            def generate(self, ids, max_new, sampling, cancel, embeddings=None):
                try:
                    yield from super().generate(ids, max_new, sampling, cancel, embeddings)
                finally:
                    # Deterministic native-engine DONE metadata; no GPU or
                    # wall-clock-derived speed is used in this HTTP fixture.
                    self.last = {"reused": 16, "prompt_read": len(ids)-16,
                                 "prompt_ms": 250.0, "decode_ms": 500.0,
                                 "generated": 20, "hits": 60, "lookups": 100}
        tokenizer = server.ByteTokenizer()
        self.start(engine=Timed(tokenizer, "</think>\n\nfixture reply"))
        self.assertFalse(self.svc.api_monitor)
        status, text = self.post("/v1/chat/completions", {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 64})
        self.assertEqual(status, 200, text)
        timings = json.loads(text)["timings"]
        run = self.events("run_end")[0]
        self.assertEqual(run["cacheReadTokens"], 16)
        self.assertEqual(run["prefillTokens"], timings["prompt_n"])
        self.assertEqual(run["prefillS"], 0.25)
        self.assertEqual(run["decodeS"], 0.5)
        self.assertEqual(run["prefillTokS"], timings["prompt_per_second"])
        self.assertEqual(run["decodeTokS"], 40.0)
        self.assertEqual(run["expertCacheHits"], 60)
        self.assertEqual(run["expertCacheLookups"], 100)
        # Metadata collection works while the independent body viewer is off.
        with self.assertRaises(urllib.error.HTTPError) as disabled:
            urllib.request.urlopen(self.base + "/api/requests", timeout=5)
        self.assertEqual(disabled.exception.code, 404)
        self.svc.api_monitor = True
        with urllib.request.urlopen(self.base + "/api/requests", timeout=5) as enabled:
            self.assertEqual(json.loads(enabled.read())["persistent"], False)

    def test_early_auth_forbidden_json_errors_count_without_runs(self):
        self.start()
        body = {"messages":[{"role":"user","content":"PRIVATE_PROMPT_123"}],"max_tokens":2}
        self.svc.api_key = "PRIVATE_API_KEY_123"
        self.assertEqual(self.post("/v1/chat/completions",body)[0],401)
        self.assertEqual(self.post("/v1/messages",body,{"Authorization":"Bearer PRIVATE_WRONG_KEY_123"})[0],401)
        self.svc.api_key = ""
        self.assertEqual(self.post("/v1/responses",{}, {"Origin":"https://untrusted.invalid"})[0],403)
        self.assertEqual(self.post("/v1/messages",{},raw=b"{invalid PRIVATE_JSON_123")[0],400)
        ends = self.events("request_end")
        self.assertEqual([e["httpStatus"] for e in ends],[401,401,403,400])
        self.assertTrue(all(e["outcome"] == "failed" and e["firstTokenS"] is None for e in ends))
        self.assertFalse(self.events("run_end"))
        self.assertTrue(all(e["clientId"] is None for e in ends))
        self.assertNotIn("PRIVATE",json.dumps(self.events()))

    @unittest.skipUnless(SOURCE_HASH in KEEP_AWAKE_SOURCE_HASHES, "requires reviewed Strata 0.1.42 or newer")
    def test_sampling_and_bias_validation_preserve_failed_request_accounting(self):
        self.start()
        cases = [("/v1/chat/completions", {"logit_bias": {"1": "PRIVATE_INVALID_BIAS"}}),
                 ("/v1/chat/completions", {"temperature": "PRIVATE_INVALID_NUMBER"}),
                 ("/v1/responses", {"temperature": "PRIVATE_INVALID_NUMBER"}),
                 ("/v1/messages", {"temperature": "PRIVATE_INVALID_NUMBER"})]
        for path, invalid in cases:
            status, text = self.post(path, {"messages": [{"role": "user", "content": "hello"}],
                                           "input": "hello", "max_tokens": 64, "stream": True, **invalid})
            self.assertEqual(status, 400, text)
        ends = self.events("request_end")
        self.assertEqual(len(ends), len(cases))
        self.assertTrue(all(e["outcome"] == "failed" and e["httpStatus"] == 400 for e in ends))
        self.assertFalse(self.events("run_end"))
        self.assertNotIn("PRIVATE", json.dumps(self.events()))
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM active_requests").fetchone()[0], 0)

    @unittest.skipUnless(SOURCE_HASH in KEEP_AWAKE_SOURCE_HASHES, "requires reviewed Strata 0.1.42 or newer")
    def test_keep_awake_released_after_success_and_observed_generator_close(self):
        class Awake:
            def __init__(self):
                self.acquired = self.released = 0
            def acquire(self):
                self.acquired += 1
            def release(self):
                self.released += 1
        self.start("</think>\n\n" + "reply " * 30)
        awake = self.svc.keep_awake = Awake()
        status, text = self.post("/v1/chat/completions", {
            "messages": [{"role": "user", "content": "hello"}], "max_tokens": 64})
        self.assertEqual(status, 200, text)
        self.events("request_end")
        self.assertEqual((awake.acquired, awake.released), (1, 1))
        # Close the actual upstream generator while it holds its inference turn.
        # This exercises observer.run -> official run -> official _run -> engine,
        # including the newly introduced keep-awake finally and FIFO cleanup.
        previous = getattr(observer._local, "request", None)
        observer._local.request = {"requestId": "isolated-generator-close", "cancelled": False,
                                   "errorKind": None, "modelId": None, "clock": time.perf_counter()}
        generator = self.svc.run([1], False, None, 128, {}, threading.Event())
        try:
            kind, _ = next(generator)
            self.assertEqual(kind, "event")
            self.assertEqual((awake.acquired, awake.released), (2, 1))
        finally:
            generator.close()
            observer._local.request = previous
        self.assertEqual((awake.acquired, awake.released), (2, 2))
        closed = [r for r in self.events("run_end") if r["requestId"] == "isolated-generator-close"]
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["finish"], "disconnect")
        self.assertIsNone(getattr(observer._local, "run", None))
        self.assertTrue(self.svc.fifo.acquire(blocking=False))
        self.svc.fifo.release()

    @unittest.skipUnless(SOURCE_HASH in NONFINITE_SOURCE_HASHES, "requires reviewed Strata 0.1.43 or newer")
    def test_0143_nonfinite_retry_and_failure_keep_one_request_and_release_admission(self):
        class NonFinite(server.MockEngine):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.plan, self.calls, self.flushed = [], [], False
            def generate(self, ids, max_new, sampling, cancel, embeddings=None):
                self.calls.append(list(ids))
                cut = self.plan.pop(0) if self.plan else None
                reused = 0 if self.flushed else len(ids) - 1
                self.last = {"prompt_tokens": len(ids), "reused": reused,
                             "prompt_read": len(ids) - reused, "prompt_ms": 250.0,
                             "decode_ms": 500.0, "generated": cut or 20,
                             "hits": 999 if cut == 0 else 3, "lookups": 1000 if cut == 0 else 4,
                             "finish": "nonfinite" if cut is not None else "stop"}
                self.flushed = False
                for index, token in enumerate(super().generate(ids, max_new, sampling, cancel, embeddings)):
                    if cut is not None and index >= cut:
                        break
                    yield token
                if cut is not None:
                    self.flushed = True
                    raise server.EngineNonFinite("fixture non-finite output")
        tok = server.ByteTokenizer()
        engine = NonFinite(tok, "</think>\n\nfixture reply", max_context=32768)
        self.start(engine=engine)
        count = 0
        for path in ("/v1/chat/completions", "/v1/responses", "/v1/messages"):
            for stream in (False, True):
                for plan, finish in (([0], "stop"), ([0, 0], "error"), ([12], "length")):
                    with self.subTest(path=path, stream=stream, finish=finish):
                        before_activity = self.activity()[1]
                        before_calls = len(engine.calls)
                        engine.plan = list(plan)
                        status, text = self.post(path, {
                            "messages": [{"role": "user", "content": "PRIVATE_NONFINITE_PROMPT"}],
                            "input": "PRIVATE_NONFINITE_PROMPT", "stream": stream,
                            "max_tokens": 64, "max_output_tokens": 64})
                        self.assertEqual(status, 503 if finish == "error" and not stream else 200, text)
                        count += 1
                        ends, runs = self.events("request_end"), self.events("run_end")
                        self.assertEqual((len(ends), len(runs)), (count, count))
                        self.assertEqual(ends[-1]["requestId"], runs[-1]["requestId"])
                        self.assertEqual(ends[-1]["outcome"], "failed" if finish == "error" else "succeeded")
                        self.assertEqual(runs[-1]["finish"], finish)
                        self.assertEqual(len(engine.calls) - before_calls, 1 if finish == "length" else 2)
                        if finish == "error":
                            # Anthropic streaming retains its upstream api_error
                            # shape; all other paths use server_error here.
                            self.assertIn("api_error" if path == "/v1/messages" and stream else "server_error", text)
                            self.assertIsNone(ends[-1]["firstTokenS"])
                        elif finish == "stop":
                            # The discarded non-finite pass must not inflate
                            # cache/native counters for the successful retry.
                            self.assertEqual(runs[-1]["cacheReadTokens"], 0)
                            self.assertEqual(runs[-1]["expertCacheHits"], 3)
                            self.assertEqual(runs[-1]["expertCacheLookups"], 4)
                        else:
                            self.assertEqual(runs[-1]["outputTokens"], 12)
                        self.assertEqual(self.wait_released_activity(before_activity + 2)[1], before_activity + 2)
                        self.assertTrue(self.svc.fifo.acquire(blocking=False))
                        self.svc.fifo.release()
        self.assertNotIn("PRIVATE_NONFINITE_PROMPT", json.dumps(self.events()))

    @unittest.skipUnless(SOURCE_HASH in NONFINITE_SOURCE_HASHES, "requires reviewed Strata 0.1.43 or newer")
    def test_0143_slot_prompt_read_preserves_native_timings_and_input_total(self):
        class TimedSlot(server.MockEngine):
            def generate(self, ids, max_new, sampling, cancel, embeddings=None):
                try:
                    yield from super().generate(ids, max_new, sampling, cancel, embeddings)
                finally:
                    self.last = {"reused": 8, "prompt_read": len(ids) - 24,
                                 "prompt_ms": 250.0, "decode_ms": 500.0,
                                 "generated": 20, "hits": 3, "lookups": 4}
        tok = server.ByteTokenizer()
        self.start(engine=TimedSlot(tok, "</think>\n\nfixture reply", max_context=32768))
        status, text = self.post("/v1/chat/completions", {
            "messages": [{"role": "user", "content": "hello"}], "max_tokens": 64})
        self.assertEqual(status, 200, text)
        result, run = json.loads(text), self.events("run_end")[0]
        self.assertEqual(result["timings"]["cache_n"], 24)
        self.assertEqual(run["cacheReadTokens"], 24)
        self.assertEqual(run["prefillTokens"], result["timings"]["prompt_n"])
        self.assertEqual(run["inputTokens"], run["prefillTokens"] + run["cacheReadTokens"])
        self.assertEqual(run["inputTokens"], result["usage"]["prompt_tokens"])
        self.assertEqual((run["prefillS"], run["decodeS"], run["decodeTokS"]), (0.25, 0.5, 40.0))

    @unittest.skipUnless(SOURCE_HASH in RETRYABLE_503_SOURCE_HASHES, "requires official Strata 0.1.43.1 or 0.1.44")
    def test_01431_before_load_refusal_preserves_retry_after_and_capture(self):
        self.start()
        self.svc.loaded = lambda: False
        self.svc.before_load = [sys.executable, "-I", "-S", "-c", "raise SystemExit(17)"]
        self.svc.before_load_strict = True
        paths = ("/load", "/v1/chat/completions", "/v1/messages", "/v1/responses")
        for capture in (False, True):
            if capture:
                self.assertTrue(self.capture_lease())
            for path in paths:
                before_activity = self.activity()[1]
                status, text, headers = self.post_response(path, {
                    "messages": [{"role": "user", "content": "PRIVATE_BUSY_PROMPT"}],
                    "input": "PRIVATE_BUSY_PROMPT", "max_tokens": 64,
                })
                self.assertEqual(status, 503, text)
                self.assertEqual(json.loads(text)["error"]["type"], "server_error")
                # The official Responses preparation handler does not attach
                # Retry-After; preserve each route's upstream response exactly.
                self.assertEqual(headers.get("Retry-After"), None if path == "/v1/responses" else "15")
                self.assertEqual(self.wait_released_activity(before_activity + 2)[1], before_activity + 2)
            if capture:
                self.assertEqual(len(self.svc.api_requests), 3)
                for record in self.svc.api_requests:
                    self.assertEqual(record["http_status"], 503)
                    self.assertEqual(json.loads(record["response"])["error"]["type"], "server_error")
                self.capture_off()
        ends = self.events("request_end")
        self.assertEqual(len(ends), 6)
        self.assertTrue(all(e["outcome"] == "failed" and e["httpStatus"] == 503 for e in ends))
        self.assertFalse(self.events("run_end"))
        self.assertNotIn("PRIVATE_BUSY_PROMPT", json.dumps(self.events()))
        self.assertEqual(self.svc.status["queued"], 0)
        self.assertTrue(self.svc.fifo.acquire(blocking=False))
        self.svc.fifo.release()

    @unittest.skipUnless(SOURCE_HASH in RETRYABLE_503_SOURCE_HASHES, "requires official Strata 0.1.43.1 or 0.1.44")
    def test_01431_retryable_engine_refusal_preserves_503_and_run_cleanup(self):
        class Busy(server.MockEngine):
            def generate(self, *args, **kwargs):
                raise server.GpuBusy("fixture batch slots refused", retry_after=5)
                yield  # Keep the native-engine generator contract.

        tok = server.ByteTokenizer()
        self.start(engine=Busy(tok, "</think>\n\nfixture reply", max_context=32768))
        self.assertTrue(self.capture_lease())
        for path in ("/v1/chat/completions", "/v1/messages"):
            before_activity = self.activity()[1]
            status, text, headers = self.post_response(path, {
                "messages": [{"role": "user", "content": "PRIVATE_SLOT_PROMPT"}], "max_tokens": 64,
            })
            self.assertEqual(status, 503, text)
            self.assertEqual(headers.get("Retry-After"), "5")
            self.assertEqual(json.loads(text)["error"]["type"], "server_error")
            self.assertEqual(self.wait_released_activity(before_activity + 2)[1], before_activity + 2)
        ends, runs = self.events("request_end"), self.events("run_end")
        self.assertEqual((len(ends), len(runs)), (2, 2))
        self.assertTrue(all(e["outcome"] == "failed" and e["httpStatus"] == 503 for e in ends))
        self.assertTrue(all(r["finish"] == "error" for r in runs))
        self.assertEqual({r["requestId"] for r in runs}, {e["requestId"] for e in ends})
        self.assertNotIn("PRIVATE_SLOT_PROMPT", json.dumps(self.events()))
        self.assertEqual(self.svc.status["queued"], 0)
        self.assertTrue(self.svc.fifo.acquire(blocking=False))
        self.svc.fifo.release()
        self.capture_off()

    @unittest.skipUnless(SOURCE_HASH in RETRYABLE_503_SOURCE_HASHES, "requires official Strata 0.1.43.1 or 0.1.44")
    def test_01431_disconnect_during_prepare_is_cancelled_without_inference(self):
        self.start()
        for index, path in enumerate(("/v1/chat/completions", "/v1/responses", "/v1/messages")):
            prepared = threading.Event()
            def waiting_prepare(*args, cancel=None, **kwargs):
                self.assertIsNotNone(cancel)
                prepared.set()
                self.assertTrue(cancel.wait(5), "client disconnect was not observed during preparation")
                raise server.ClientGone()
            self.svc.prepare = waiting_prepare
            before_activity = self.activity()[1]
            payload = json.dumps({"messages": [{"role": "user", "content": "PRIVATE_PREPARE_PROMPT"}],
                                  "input": "PRIVATE_PREPARE_PROMPT", "stream": True, "max_tokens": 64}).encode()
            with socket.create_connection(self.httpd.server_address, timeout=5) as sock:
                sock.sendall(b"POST " + path.encode() + b" HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                             b"Content-Type: application/json\r\nContent-Length: " + str(len(payload)).encode()
                             + b"\r\n\r\n" + payload)
                self.assertTrue(prepared.wait(3), path)
                sock.shutdown(socket.SHUT_RDWR)
            self.assertEqual(self.wait_released_activity(before_activity + 2)[1], before_activity + 2)
            ends = self.events("request_end")
            self.assertEqual(len(ends), index + 1)
            self.assertEqual(ends[-1]["outcome"], "cancelled")
            self.assertIsNone(ends[-1]["httpStatus"])
        self.assertFalse(self.events("run_end"))
        self.assertNotIn("PRIVATE_PREPARE_PROMPT", json.dumps(self.events()))
        self.assertTrue(self.svc.fifo.acquire(blocking=False))
        self.svc.fifo.release()

    def test_stream_engine_error_is_failure_despite_http_200(self):
        class Faulty(server.MockEngine):
            def generate(self, *args, **kwargs):
                for index, token in enumerate(super().generate(*args, **kwargs)):
                    if index == 14:
                        raise ValueError("fixture engine failed")
                    yield token
        for path in ("/v1/chat/completions","/v1/responses","/v1/messages"):
            tok = server.ByteTokenizer()
            self.start(engine=Faulty(tok,"</think>\n\n"+"xy"*100))
            status,text = self.post(path,{"messages":[{"role":"user","content":"hi"}],"input":"hi","stream":True,"max_tokens":100})
            self.assertEqual(status,200,text)
            self.assertIn("error",text)
        ends=self.events("request_end")
        self.assertEqual(len(ends),3)
        self.assertTrue(all(e["outcome"]=="failed" and e["httpStatus"]==200 for e in ends))
        self.assertTrue(all(r["finish"]=="error" for r in self.events("run_end")))

    def test_disconnect_is_cancelled_not_success(self):
        for index,path in enumerate(("/v1/chat/completions","/v1/responses","/v1/messages")):
            self.start("</think>\n\n"+"xy"*1000, delay=0.002)
            payload=json.dumps({"messages":[{"role":"user","content":"hi"}],"input":"hi","stream":True,"max_tokens":1000}).encode()
            sock=socket.create_connection(self.httpd.server_address,timeout=5)
            sock.sendall(b"POST "+path.encode()+b" HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: "+str(len(payload)).encode()+b"\r\n\r\n"+payload)
            sock.recv(1024)
            sock.shutdown(socket.SHUT_RDWR)
            sock.close()
            deadline=time.monotonic()+5
            while time.monotonic()<deadline and len(self.events("request_end"))<=index:
                time.sleep(0.05)
        ends=self.events("request_end")
        self.assertEqual(len(ends),3)
        self.assertTrue(all(e["outcome"]=="cancelled" for e in ends))
        self.assertTrue(all(r["finish"]=="disconnect" for r in self.events("run_end")))

    def test_mcp_one_http_two_runs_and_no_arguments_stored(self):
        self.hub = McpHub({"fake":{"command":sys.executable,"args":[str(ROOT/"serve/mcp_fake_server.py")]}},
                          {"timeout_s":5,"max_result_chars":1000})
        self.hub.start(wait=True)
        script="</think>\n\nLet me check.\n\n<tool_call>\n<function=fake__echo>\n<parameter=text>\nPRIVATE_TOOL_ARGUMENT_123\n</parameter>\n</function>\n</tool_call>"
        self.start([script,"</think>\n\nThe tool completed."])
        status,text=self.post("/v1/chat/completions",{"model":"m","messages":[{"role":"user","content":"check it"}],"strata_mcp":True,"stream":True,"max_tokens":1000})
        self.assertEqual(status,200,text)
        self.assertIn("PRIVATE_TOOL_ARGUMENT_123",text)
        ends,runs=self.events("request_end"),self.events("run_end")
        self.assertEqual(len(ends),1)
        self.assertEqual(len(runs),2)
        self.assertEqual(ends[0]["mcpToolCalls"],1)
        self.assertEqual(sum(r["toolCalls"] for r in runs),1)
        self.assertEqual({r["requestId"] for r in runs},{ends[0]["requestId"]})
        self.assertNotIn("PRIVATE_TOOL_ARGUMENT_123",json.dumps(self.events()))

    def test_token_count_does_not_add_inference_or_usage_tokens(self):
        self.start()
        status,text=self.post("/v1/messages/count_tokens",{"messages":[{"role":"user","content":"hello"}]})
        self.assertEqual(status,200,text)
        end=self.events("request_end")[0]
        self.assertEqual(end["countedTokens"],json.loads(text)["input_tokens"])
        self.assertIsNone(end["inputTokens"])
        self.assertFalse(self.events("run_end"))

    def test_actual_loaded_model_is_metadata_not_request_model_or_alias(self):
        self.start()
        self.svc.model = "actual-loaded-model"
        self.svc.aliases = ["public-alias"]
        status, text = self.post("/v1/chat/completions", {
            "model": "public-alias", "messages": [{"role": "user", "content": "PRIVATE_PROMPT_MODEL_TEST"}], "max_tokens": 64,
        })
        self.assertEqual(status, 200, text)
        self.assertEqual(self.events("request_start")[0]["modelId"], "actual-loaded-model")
        self.assertEqual(self.events("request_end")[0]["modelId"], "actual-loaded-model")
        self.assertNotIn("public-alias", json.dumps(self.events()))
        self.assertNotIn("PRIVATE_PROMPT_MODEL_TEST", json.dumps(self.events()))

    def test_unloaded_missing_or_unsafe_model_identity_stays_unknown(self):
        self.start()
        for identity, loaded in [("not-loaded", False), (None, True), ("C:\\private\\weights.gguf", True), ("C:/private/weights.gguf", True), ("/private/weights.gguf", True), ("=HYPERLINK(private)", True)]:
            self.svc.model = identity
            self.svc.loaded = lambda: loaded
            status, text = self.post("/v1/messages/count_tokens", {"model": "PRIVATE_REQUEST_MODEL", "messages": [{"role": "user", "content": "hi"}]})
            self.assertEqual(status, 200, text)
            self.assertIsNone(self.events("request_start")[-1]["modelId"])
            self.assertIsNone(self.events("request_end")[-1]["modelId"])
        self.assertNotIn("PRIVATE_REQUEST_MODEL", json.dumps(self.events()))

    def test_lazy_request_records_model_only_after_actual_load(self):
        self.start()
        self.svc.model = "lazy-loaded-model"
        original = self.svc.begin_request
        loaded = [False]
        self.svc.loaded = lambda: loaded[0]
        def begin(*args, **kwargs):
            loaded[0] = True
            return original(*args, **kwargs)
        self.svc.begin_request = begin
        status, text = self.post("/v1/chat/completions", {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 64})
        self.assertEqual(status, 200, text)
        self.assertIsNone(self.events("request_start")[0]["modelId"])
        self.assertEqual(self.events("request_end")[0]["modelId"], "lazy-loaded-model")

    def test_lazy_reload_is_visible_without_capture_and_clears_after_ready(self):
        tok = server.ByteTokenizer()
        self.start(engine=BlockingLazyEngine(tok))
        self.assertFalse(self.svc.api_monitor)
        self.assertEqual(self.svc.metrics()["live"]["state"], "idle")
        self.assertEqual(self.svc.unload(), "unloaded")

        def metrics():
            with urllib.request.urlopen(self.base + "/metrics", timeout=5) as response:
                return json.load(response)["live"]

        before = metrics()
        self.assertEqual(before["state"], "unloaded")
        self.assertNotIn("load_elapsed_s", before)
        body = {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 64}
        results, failures = [], []

        def request():
            try:
                results.append(self.post("/v1/chat/completions", body))
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=request) for _ in range(2)]
        try:
            threads[0].start()
            self.assertTrue(self.engine.load_entered.wait(3))
            first = metrics()
            self.assertEqual(first["state"], "loading")
            self.assertEqual(first["phase"], "loading model")
            self.assertGreaterEqual(first["load_elapsed_s"], 0)
            self.assertIsNone(first["tok_s"])
            threads[1].start()
            deadline = time.monotonic() + 3
            while self.journal.db.execute("SELECT COUNT(*) FROM active_requests WHERE service_id='fixture'").fetchone()[0] < 2:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.005)
            second = metrics()
            self.assertEqual(second["state"], "loading")
            self.assertGreaterEqual(second["load_elapsed_s"], first["load_elapsed_s"])
        finally:
            self.engine.load_release.set()
            for thread in threads:
                if thread.ident is not None:
                    thread.join(timeout=5)
        self.assertFalse(failures, failures)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(self.engine.restarts, 1)
        after = metrics()
        self.assertEqual(after["state"], "idle")
        self.assertNotIn("load_elapsed_s", after)
        self.svc.ensure_loaded()  # A loaded-model no-op cannot create load state.
        self.assertEqual(self.svc.metrics()["live"]["state"], "idle")
        self.assertEqual(self.engine.restarts, 1)
        self.assertEqual(self.svc.unload(), "unloaded")
        unloaded = metrics()
        self.assertEqual(unloaded["state"], "unloaded")
        self.assertNotIn("load_elapsed_s", unloaded)
        self.assertEqual(len(self.events("request_end")), 2)
        self.assertTrue(all(event["outcome"] == "succeeded" for event in self.events("request_end")))
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM active_requests WHERE service_id='fixture'").fetchone()[0], 0)

    def test_reload_failure_clears_loading_and_preserves_request_error(self):
        tok = server.ByteTokenizer()
        failure = server.GpuBusy("fixture GPU refusal")
        self.start(engine=BlockingLazyEngine(tok, failure))
        self.assertEqual(self.svc.unload(), "unloaded")
        results = []
        thread = threading.Thread(target=lambda: results.append(self.post("/v1/chat/completions", {
            "messages": [{"role": "user", "content": "hello"}], "max_tokens": 64})))
        try:
            thread.start()
            self.assertTrue(self.engine.load_entered.wait(3))
            with urllib.request.urlopen(self.base + "/metrics", timeout=5) as response:
                live = json.load(response)["live"]
            self.assertEqual(live["state"], "loading")
            self.assertIn("load_elapsed_s", live)
        finally:
            self.engine.load_release.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0][0], 503)
        self.assertIn("fixture GPU refusal", results[0][1])
        after = self.svc.metrics()["live"]
        self.assertEqual(after["state"], "unloaded")
        self.assertNotIn("load_elapsed_s", after)
        self.assertEqual(self.events("request_end")[0]["outcome"], "failed")
        self.assertFalse(self.events("run_end"))
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM active_requests WHERE service_id='fixture'").fetchone()[0], 0)

    def test_maintenance_drains_existing_request_and_blocks_new_admission(self):
        self.start("</think>\n\n"+"xy"*80, delay=0.002)
        box={}
        thread=threading.Thread(target=lambda:box.update(result=self.post("/v1/chat/completions",{"messages":[{"role":"user","content":"hi"}],"max_tokens":100})))
        thread.start()
        deadline=time.monotonic()+5
        while not self.journal.db.execute("SELECT COUNT(*) FROM active_requests WHERE service_id='fixture'").fetchone()[0]:
            self.assertLess(time.monotonic(),deadline);time.sleep(0.005)
        db=sqlite3.connect(self.journal.path)
        db.execute("BEGIN IMMEDIATE")
        gate=Path(self.temp.name)/"fixture.maintenance"
        gate.write_text("maintenance")
        db.commit();db.close()
        try:
            status,_=self.post("/v1/chat/completions",{"messages":[{"role":"user","content":"blocked"}],"max_tokens":10})
            self.assertEqual(status,503)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(box["result"][0],200)
            deadline=time.monotonic()+2
            while self.journal.db.execute("SELECT COUNT(*) FROM active_requests WHERE service_id='fixture'").fetchone()[0] and time.monotonic()<deadline:
                time.sleep(0.01)
            self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM active_requests WHERE service_id='fixture'").fetchone()[0],0)
            self.assertEqual(len(self.events("run_end")),1)
        finally:
            gate.unlink(missing_ok=True)

    def test_tuning_and_drain_tokens_do_not_bypass_api_auth_or_leak(self):
        self.start()
        gate=Path(self.temp.name)/"fixture.maintenance"
        token="PRIVATE_MAINTENANCE_TOKEN_1234567890"
        try:
            gate.write_text(json.dumps({"mode":"tuning","token":token}))
            body={"messages":[{"role":"user","content":"hi"}],"max_tokens":10}
            self.assertEqual(self.post("/v1/chat/completions",body)[0],503)
            self.assertEqual(self.post("/v1/chat/completions",body,{"X-Strata-Manager-Tuning-Id":"wrong"})[0],503)
            self.assertEqual(self.post("/v1/chat/completions",body,{"X-Strata-Manager-Tuning-Id":token})[0],200)
            self.svc.api_key="private-api-key"
            self.assertEqual(self.post("/v1/chat/completions",body,{"X-Strata-Manager-Tuning-Id":token})[0],401)
            self.svc.api_key=""
            gate.write_text(json.dumps({"mode":"drain","token":token}))
            self.assertEqual(self.post("/unload",{}, {"X-Strata-Manager-Maintenance-Token":token})[0],200)
            self.assertNotIn(token,json.dumps(self.events()))
        finally:
            gate.unlink(missing_ok=True)

    def activity(self):
        return self.journal.db.execute("SELECT session_id,revision,last_activity_ms "
                                       "FROM service_activity WHERE service_id='fixture'").fetchone()

    def wait_released_activity(self, minimum_revision):
        deadline=time.monotonic()+3
        while True:
            row=self.activity()
            active=self.journal.db.execute("SELECT COUNT(*) FROM active_requests "
                                           "WHERE service_id='fixture'").fetchone()[0]
            if active == 0 and row[1] >= minimum_revision:
                return row
            self.assertLess(time.monotonic(),deadline)
            time.sleep(0.005)

    def test_completed_load_records_activity_after_the_admission_row_is_gone(self):
        self.start()
        before=self.activity()
        self.assertEqual(self.post("/load?PRIVATE_QUERY_123",{})[0],200)
        after=self.wait_released_activity(before[1]+2)
        self.assertEqual(after[0],self.journal.session_id)
        self.assertEqual(after[1],before[1]+2)
        self.assertGreaterEqual(after[2],before[2])
        self.assertEqual(len(self.events("request_start")),0)
        saved=self.journal.db.execute("SELECT * FROM service_activity").fetchall()
        self.assertNotIn("PRIVATE_QUERY_123",json.dumps(saved))

    def test_health_and_metrics_polling_and_unknown_posts_do_not_extend_idle(self):
        self.start()
        before=self.activity()
        for _ in range(3):
            for path in ("/health","/metrics","/settings"):
                with urllib.request.urlopen(self.base+path,timeout=5) as response:
                    self.assertEqual(response.status,200)
        self.assertEqual(self.post("/unknown-control?PRIVATE_QUERY_123",{})[0],404)
        time.sleep(0.03)
        self.assertEqual(self.activity(),before)
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM active_requests "
                                               "WHERE service_id='fixture'").fetchone()[0],0)

    def test_inflight_revision_and_completed_revision_are_distinct_and_gate_rejection_is_not_activity(self):
        self.start("</think>\n\n"+"xy"*80,delay=0.002)
        before=self.activity()
        box={}
        thread=threading.Thread(target=lambda:box.update(result=self.post("/v1/chat/completions",{
            "messages":[{"role":"user","content":"hi"}],"max_tokens":100})))
        thread.start()
        gate=Path(self.temp.name)/"fixture.maintenance"
        try:
            deadline=time.monotonic()+3
            while not self.journal.db.execute("SELECT COUNT(*) FROM active_requests "
                                             "WHERE service_id='fixture'").fetchone()[0]:
                self.assertLess(time.monotonic(),deadline);time.sleep(0.005)
            self.assertEqual(self.activity()[1],before[1]+1)
            db=sqlite3.connect(self.journal.path)
            db.execute("BEGIN IMMEDIATE")
            gate.write_text(json.dumps({"mode":"drain","token":"isolated-"+"x"*32}))
            db.commit();db.close()
            self.assertEqual(self.post("/load",{})[0],503)
            self.assertEqual(self.activity()[1],before[1]+1)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(box["result"][0],200)
            self.assertEqual(self.wait_released_activity(before[1]+2)[1],before[1]+2)
        finally:
            thread.join(timeout=5)
            gate.unlink(missing_ok=True)


    def capture_lease(self, duration_ms=60000, **changes):
        lease={"protocolVersion":1,"serviceId":self.journal.service_id,"sessionId":self.journal.session_id,
               "pid":os.getpid(),"sourceHash":SOURCE_HASH,"token":observer.uuid.uuid4().hex,
               "createdAtMs":int(time.time()*1000),"expiresAtMs":int(time.time()*1000)+duration_ms}
        lease.update(changes)
        with self.journal.lock:
            self.journal.db.execute("INSERT INTO request_capture_leases VALUES(?,?) ON CONFLICT(service_id) DO UPDATE SET payload=excluded.payload",
                                    (self.journal.service_id,json.dumps(lease)))
            self.journal.db.commit()
        return self.svc._manager_capture.refresh(force=True)

    def capture_off(self):
        with self.journal.lock:
            self.journal.db.execute("DELETE FROM request_capture_leases WHERE service_id=?",(self.journal.service_id,))
            self.journal.db.commit()
        self.svc._manager_capture.refresh(force=True)

    def test_temporary_capture_all_official_protocols_and_default_metadata(self):
        self.start()
        self.capture_off()
        self.assertFalse(self.svc.api_monitor)
        self.assertTrue(self.capture_lease())
        paths=[("/v1/chat/completions",{"messages":[{"role":"user","content":"TEMP_BODY_SECRET"}]}),
               ("/v1/responses",{"input":"TEMP_BODY_SECRET"}),
               ("/v1/messages",{"messages":[{"role":"user","content":"TEMP_BODY_SECRET"}]})]
        for path,body in paths:
            for stream in (False,True):
                status,text=self.post(path,{**body,"max_tokens":64,"stream":stream})
                self.assertEqual(status,200,text)
        with urllib.request.urlopen(self.base+"/api/requests") as response:
            listing=json.load(response)
        self.assertEqual(len(listing["requests"]),6)
        self.assertFalse(listing["persistent"])
        for record in listing["requests"]:
            with urllib.request.urlopen(self.base+"/api/requests?id="+record["id"]) as response:
                detail=json.load(response)
            self.assertIn("TEMP_BODY_SECRET",detail["input"])
            self.assertIn("fixture reply",detail["output"])
            self.assertEqual(detail["state"],"completed")
            self.assertNotIn("_manager_capture_token",detail)
        self.assertNotIn("TEMP_BODY_SECRET",json.dumps(self.events()))
        self.assertFalse(self.svc.api_monitor)
        self.capture_off()
        self.assertEqual(len(self.svc.api_requests),0)
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base+"/api/requests")
        self.assertEqual(error.exception.code,404)
        self.assertEqual(self.post('/v1/chat/completions',{'messages':[{'role':'user','content':'after off'}],'max_tokens':64})[0],200)
        self.assertEqual(len(self.svc.api_requests),0)

    def test_capture_expiry_and_disable_during_stream_do_not_interrupt_api(self):
        for expire in (True,False):
            self.start(script='</think>\n\n'+'stream body '*15,delay=.008)
            self.capture_off()
            self.assertTrue(self.capture_lease())
            result=[]
            worker=threading.Thread(target=lambda:result.append(self.post('/v1/chat/completions',
                {'messages':[{'role':'user','content':'LONG_STREAM_SECRET'}],'max_tokens':200,'stream':True})))
            worker.start()
            deadline=time.monotonic()+5
            while not self.svc.api_requests and time.monotonic()<deadline:time.sleep(.01)
            record=self.svc.api_requests[0]
            if expire:
                # Monotonic expiry works even if the wall clock has not reached the DB expiry.
                self.svc._manager_capture.deadline=time.monotonic()-.01
                self.svc._manager_capture.refresh(force=True)
            else:self.capture_off()
            self.assertNotIn('LONG_STREAM_SECRET',json.dumps(record))
            self.assertEqual(len(self.svc.api_requests),0)
            worker.join(10)
            self.assertFalse(worker.is_alive())
            self.assertEqual(result[0][0],200,result)
            self.assertIn('data:',result[0][1])
            for body in ('input','output','reasoning','response','error'):self.assertNotIn(body,record)
            self.assertFalse(self.svc.api_monitor)
            self.assertFalse(self.svc._manager_capture.refresh(force=True))
            self.assertEqual(self.post('/v1/chat/completions',{'messages':[{'role':'user','content':'must remain off'}],'max_tokens':64})[0],200)
            self.assertEqual(len(self.svc.api_requests),0)
            self.capture_off()

    def test_capture_identity_invalid_database_and_time_fail_closed(self):
        self.start()
        for changes in ({'pid':os.getpid()+1},{'sessionId':'0'*32},{'sourceHash':'0'*64},{'protocolVersion':2},{'expiresAtMs':1}):
            self.assertFalse(self.capture_lease(**changes))
            self.assertFalse(self.svc.api_monitor)
        self.assertTrue(self.capture_lease())
        self.assertEqual(self.post('/v1/chat/completions',{'messages':[{'role':'user','content':'ERASE_DB_SECRET'}],'max_tokens':64})[0],200)
        self.svc._manager_capture.last_wall=int(time.time()*1000)+10000
        self.assertFalse(self.svc._manager_capture.refresh(force=True))
        self.assertEqual(len(self.svc.api_requests),0)
        self.capture_off()
        self.assertTrue(self.capture_lease())
        with self.journal.lock:
            self.journal.db.execute('ALTER TABLE request_capture_leases RENAME TO lease_temporarily_unavailable')
            self.journal.db.commit()
        try:
            self.assertFalse(self.svc._manager_capture.refresh(force=True))
            self.assertEqual(self.post('/v1/chat/completions',{'messages':[{'role':'user','content':'still works'}],'max_tokens':64})[0],200)
            self.assertEqual(len(self.svc.api_requests),0)
        finally:
            with self.journal.lock:
                self.journal.db.execute('ALTER TABLE lease_temporarily_unavailable RENAME TO request_capture_leases')
                self.journal.db.commit()
            self.capture_off()

    def test_manual_capture_is_not_claimed_or_closed_and_bodies_are_bounded(self):
        self.start()
        self.capture_off()
        self.svc.api_monitor=True
        self.assertFalse(self.capture_lease())
        self.assertEqual(self.post('/v1/chat/completions',{'messages':[{'role':'user','content':'MANUAL_SECRET'}],'max_tokens':64})[0],200)
        self.capture_off()
        self.assertTrue(self.svc.api_monitor)
        self.assertIn('MANUAL_SECRET',self.svc.api_requests[0]['input'])
        self.svc.api_monitor=False
        self.svc.api_requests.clear()
        self.assertTrue(self.capture_lease())
        status,_=self.post('/v1/chat/completions',{'messages':[{'role':'user','content':'x'*300000}],'max_tokens':64})
        self.assertEqual(status,400)
        record=self.svc.api_requests[-1]
        self.assertEqual(len(record['input']),262144)
        self.assertTrue(record['input_truncated'])
        self.capture_off()


class JournalAndLoader(unittest.TestCase):
    def test_concurrent_load_observation_preserves_errors_and_original_metrics(self):
        failure = RuntimeError("original load failure")
        entered = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]

        class Fixture:
            def __init__(self):
                self.ready = False
                self.report = {"live": {"state": "unloaded", "queued": 2}, "untouched": object()}

            def loaded(self):
                return self.ready

            def ensure_loaded(self, slot, fail=False):
                if self.ready:
                    return "already loaded"
                entered[slot].set()
                if not release[slot].wait(5):
                    raise RuntimeError("fixture load was not released")
                if fail:
                    raise failure
                return slot

            def metrics(self, all_requests=False):
                return self.report

            def run(self, *args, **kwargs):
                yield None

            def _note(self, *args, **kwargs):
                pass

            def begin_request(self, path, req):
                pass

        with tempfile.TemporaryDirectory() as temp:
            journal = observer.Journal(temp, "concurrent-load")
            observer.instrument_globals({"Service": Fixture, "make_handler": lambda value: value},
                                        journal=journal, source_hash="fixture", allow_fixture=True)
            journal.close()  # The load signal has no durable analytics dependency.
            svc, other = Fixture(), Fixture()
            outcomes, errors = [], []

            def invoke(slot, fail=False):
                try:
                    outcomes.append(svc.ensure_loaded(slot, fail=fail))
                except BaseException as error:
                    errors.append(error)

            threads = [threading.Thread(target=invoke, args=(0, True)),
                       threading.Thread(target=invoke, args=(1,))]
            try:
                for index, thread in enumerate(threads):
                    thread.start()
                    self.assertTrue(entered[index].wait(3))
                live = svc.metrics(all_requests=True)
                self.assertEqual(live["live"]["state"], "loading")
                self.assertIn("load_elapsed_s", live["live"])
                self.assertIsNot(live, svc.report)
                self.assertIsNot(live["live"], svc.report["live"])
                self.assertIs(live["untouched"], svc.report["untouched"])
                self.assertEqual(svc.report["live"], {"state": "unloaded", "queued": 2})
                self.assertIs(other.metrics(), other.report)
                release[0].set()
                threads[0].join(timeout=5)
                self.assertFalse(threads[0].is_alive())
                self.assertEqual(errors, [failure])
                self.assertEqual(svc.metrics()["live"]["state"], "loading")
            finally:
                for event in release:
                    event.set()
                for thread in threads:
                    if thread.ident is not None:
                        thread.join(timeout=5)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(outcomes, [1])
            self.assertIs(svc.metrics(), svc.report)
            self.assertNotIn("load_elapsed_s", svc.metrics()["live"])
            svc.ready = True
            self.assertEqual(svc.ensure_loaded(0), "already loaded")
            self.assertIs(svc.metrics(), svc.report)

    def test_verified_official_source_has_observer_contract(self):
        if SOURCE_HASH not in observer.SUPPORTED_HASHES:
            self.skipTest("the checkout isn't a verified observer runtime")
        module = ast.parse((ROOT / "serve/server.py").read_text(encoding="utf-8"))
        service = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == "Service")
        methods = {n.name: n for n in service.body if isinstance(n, ast.FunctionDef)}
        signatures = {"run": "self, ids, thinking, tools, max_new, sampling, cancel, force=None",
                      "ensure_loaded": "self", "metrics": "self, all_requests=False",
                      "_note": "self, n, evs, st=None, rate=None", "begin_request": "self, path, req"}
        for name, arguments in signatures.items():
            self.assertEqual(ast.unparse(methods[name].args), arguments, name)
        handler_factory = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == "make_handler")
        handler = next(n for n in handler_factory.body if isinstance(n, ast.ClassDef))
        handler_methods = {n.name: n for n in handler.body if isinstance(n, ast.FunctionDef)}
        json_arguments = "self, code, obj, headers=None" if SOURCE_HASH in HEADER_JSON_SOURCE_HASHES else "self, code, obj"
        for name, arguments in {"do_POST": "self", "send_response": "self, code, message=None",
                                "_note": "self, **values", "_json": json_arguments,
                                "_capture": "self, items, api"}.items():
            self.assertEqual(ast.unparse(handler_methods[name].args), arguments, name)
        if SOURCE_HASH in KEEP_AWAKE_SOURCE_HASHES:
            self.assertEqual(ast.unparse(methods["_run"].args), signatures["run"])
            calls = [n for n in ast.walk(methods["run"]) if isinstance(n, ast.Call)]
            self.assertTrue(any(isinstance(n.func, ast.Attribute) and n.func.attr == "_run" for n in calls))
        # The observer gathers engine-cache values before the original service
        # releases this request's turn; the done dict still supplies its timings.
        run_body = methods.get("_run", methods["run"])
        self.assertTrue(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                            and n.func.id == "request_stats" for n in ast.walk(run_body)))
        self.assertTrue(any(isinstance(n, ast.Dict) and {"finish", "completion_tokens", "timings"}
                            <= {k.value for k in n.keys if isinstance(k, ast.Constant)} for n in ast.walk(run_body)))

    def test_activity_session_replacement_resets_revision_and_old_release_cannot_touch_it(self):
        with tempfile.TemporaryDirectory() as temp:
            old=observer.Journal(temp,"activity-session")
            self.assertTrue(old.admit("old-inflight"))
            fresh=observer.Journal(temp,"activity-session")
            try:
                self.assertNotEqual(old.session_id,fresh.session_id)
                self.assertEqual(fresh.db.execute("SELECT COUNT(*) FROM service_activity").fetchone()[0],1)
                row=fresh.db.execute("SELECT session_id,revision FROM service_activity").fetchone()
                self.assertEqual(row,(fresh.session_id,0))
                self.assertEqual(fresh.db.execute("SELECT COUNT(*) FROM active_requests").fetchone()[0],0)
                old.release("old-inflight")
                self.assertEqual(fresh.db.execute("SELECT session_id,revision FROM service_activity").fetchone(),row)
                self.assertTrue(fresh.admit("fresh-inflight"))
                fresh.release("fresh-inflight")
                self.assertEqual(fresh.db.execute("SELECT revision FROM service_activity").fetchone()[0],2)
            finally:
                old.close();fresh.close()

    def test_anthropic_cache_usage_is_not_double_counted(self):
        ctx={"route":"anthropic","inputTokens":None,"cacheReadTokens":None,"cacheCreationTokens":None}
        observer._usage(ctx,{"input_tokens":100,"output_tokens":0})
        observer._usage(ctx,{"input_tokens":15,"cache_read_input_tokens":80,"cache_creation_input_tokens":5,"output_tokens":20})
        self.assertEqual(ctx["inputTokens"],100)
        self.assertEqual(ctx["cacheReadTokens"],80)
        self.assertEqual(ctx["cacheCreationTokens"],5)
        self.assertEqual(ctx["outputTokens"],20)

    def test_journal_failure_never_changes_api_exception_flow(self):
        with tempfile.TemporaryDirectory() as temp:
            journal=observer.Journal(temp,"failure")
            journal.db.close()
            self.assertFalse(journal.append("request_end",{"requestId":"id"}))
            self.assertTrue(journal.failed)
            self.assertEqual(json.loads(journal.status_path.read_text())["error"],"journal_write_failed")
            journal.closed=True

    def test_bounded_retention_reports_unacked_gap(self):
        with tempfile.TemporaryDirectory() as temp:
            journal=observer.Journal(temp,"bounded",max_events=32)
            for index in range(256):
                journal.append("session_end",{"sessionId":"s","serviceId":"bounded","endedAtMs":index})
            count=journal.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            dropped=int(journal.db.execute("SELECT value FROM meta WHERE key='dropped_through'").fetchone()[0])
            self.assertLessEqual(count,32)
            self.assertGreater(dropped,0)
            journal.close()

    def test_unverified_module_keeps_api_available_and_marks_unsupported(self):
        with tempfile.TemporaryDirectory() as temp:
            journal=observer.Journal(temp,"unsupported")
            sentinel=object()
            ns={"Service":sentinel,"make_handler":lambda value:value}
            original=ns.copy()
            observer.instrument_globals(ns,journal=journal,source_hash="0"*64)
            self.assertEqual(ns,original)
            status=json.loads(journal.status_path.read_text())
            self.assertFalse(status["supported"])
            self.assertEqual(status["error"],"unsupported_runtime")
            journal.close()

    def test_real_minus_m_bootstrap_keeps_official_checkout_unchanged(self):
        before=hashlib.sha256((ROOT/"serve/server.py").read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp)
            shutil.copyfile(RESOURCE,directory/"strata_observer.py")
            (directory/"sitecustomize.py").write_text("import strata_observer\nstrata_observer.install()\n")
            with socket.socket() as free:
                free.bind(("127.0.0.1",0));port=free.getsockname()[1]
            env={**os.environ,"PYTHONPATH":str(directory),"STRATA_MANAGER_ANALYTICS_DIR":str(directory/"analytics"),"STRATA_MANAGER_SERVICE_ID":"loader"}
            proc=subprocess.Popen([sys.executable,"-u","-m","serve.server","--engine","mock","--port",str(port),"--script","</think>\n\nhello"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            try:
                url="http://127.0.0.1:"+str(port)
                deadline=time.monotonic()+10
                while True:
                    try:
                        with urllib.request.urlopen(url+"/health",timeout=0.5) as r:
                            self.assertEqual(r.status,200)
                        break
                    except (OSError,urllib.error.URLError):
                        if proc.poll() is not None or time.monotonic()>deadline:
                            self.fail("bootstrap server didn't start: "+proc.communicate(timeout=2)[0].decode(errors="replace"))
                        time.sleep(0.1)
                body=json.dumps({"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":30}).encode()
                with urllib.request.urlopen(urllib.request.Request(url+"/v1/chat/completions",data=body,headers={"Content-Type":"application/json"}),timeout=5) as r:
                    self.assertEqual(r.status,200)
                time.sleep(0.05)
                db=sqlite3.connect(directory/"analytics/journal.sqlite3")
                self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE kind='request_end'").fetchone()[0],1)
                db.close()
                self.assertTrue(json.loads((directory/"analytics/status-loader.json").read_text())["supported"])
            finally:
                proc.terminate();proc.communicate(timeout=10)
        self.assertEqual(hashlib.sha256((ROOT/"serve/server.py").read_bytes()).hexdigest(),before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
