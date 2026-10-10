"""Real loopback HTTP tests against upstream's MockEngine (no weights/GPU).

Place the verified upstream checkout in .reference/strata, then run:
    python apps/supervisor/tests/test_strata_observer.py
STRATA_TEST_ROOT may override that project-relative checkout path.
The upstream checkout is read-only throughout these tests.
"""
from __future__ import annotations
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


class ObserverHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="strata-observer-http-")
        cls.journal = observer.Journal(cls.temp.name, "fixture")
        digest = hashlib.sha256((ROOT / "serve/server.py").read_bytes()).hexdigest()
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
        req = urllib.request.Request(self.base + path, data=raw if raw is not None else json.dumps(payload).encode(),
              headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

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
        saved = json.dumps(self.events())
        for private in ("PRIVATE_PROMPT_123","PRIVATE_UA_123","fixture reply","Authorization","messages"):
            self.assertNotIn(private, saved)

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


class JournalAndLoader(unittest.TestCase):
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
