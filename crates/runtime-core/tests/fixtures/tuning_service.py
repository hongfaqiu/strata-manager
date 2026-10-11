"""Isolated lifecycle fixture, not a model or a performance claim.

It intentionally opts into the observer journal protocol so Rust can exercise
real HTTP admission, owned process restart, and config rollback without a GPU.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from strata_observer import Journal

parser = argparse.ArgumentParser()
parser.add_argument("--config")
parser.add_argument("--port", type=int)
parser.add_argument("--host", default="127.0.0.1")
args, _ = parser.parse_known_args()
config = json.loads(Path(args.config).read_text(encoding="utf-8"))
flags = config["args"]


def flag(name, default):
    try:
        return float(flags[flags.index(name) + 1])
    except ValueError:
        return default


pcie = flag("--pcie-frac", 0.5)
spec = flag("--spec-min-p", 0.5)
workers = int(flag("--pool-workers", 4))
adapt_async = int(flag("--adapt-async", 0))
prefill = int(flag("--prefill", 2048))
reserve = int(flag("--vram-reserve-mib", 700))
adapt_every = int(flag("--adapt-every", 4))
adapt_swaps = int(flag("--adapt-swaps", 96))
adapt_decay = flag("--adapt-decay", 0.7)
# Optional owned child supplies real process argv for unpublished-telemetry tests.
if Path(config["cwd"]).joinpath("adaptive-argv-fixture").exists():
    child_env = {key: value for key, value in os.environ.items() if key not in ("STRATA_MANAGER_SERVICE_ID", "STRATA_MANAGER_ANALYTICS_DIR")}
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)", *flags], env=child_env)
directory = Path(os.environ["STRATA_MANAGER_ANALYTICS_DIR"])
profile_id = os.environ["STRATA_MANAGER_SERVICE_ID"]
journal = Journal(directory, profile_id)
journal.status(True, "isolated-fixture")
loaded = False
active = 0
counter = 0
counter_lock = threading.Lock()


def heartbeat():
    while True:
        time.sleep(0.5)
        journal.status(True, "isolated-fixture")


threading.Thread(target=heartbeat, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.respond({"status": "ok", "service": "strata", "loaded": loaded, "model": "tuning-fixture"})
        elif self.path == "/v1/status":
            self.respond({"service": "strata", "activity": {"in_flight": active}})
        elif self.path == "/metrics":
            engine = {"model": "tuning-fixture", "version": "fixture-only", "max_context": 65536,
                                     "pcie_frac": pcie, "spec_min_p": spec, "pool_workers": workers,
                                     "adapt_async": adapt_async, "prefill": prefill, "vram_reserve_mib": reserve,
                                     "adapt_every": adapt_every, "adapt_swaps": adapt_swaps, "adapt_decay": adapt_decay}
            if Path(config["cwd"]).joinpath("unknown-effective-async").exists():
                engine.pop("adapt_async")
            if Path(config["cwd"]).joinpath("unknown-effective-adaptive").exists():
                for key in ("adapt_every", "adapt_swaps", "adapt_decay"):
                    engine.pop(key)
            hardware = {"ram_total":64 * 2**30, "ram_used":32 * 2**30,
                        "gpu_mem_total":16 * 2**30, "gpu_mem_used":8 * 2**30}
            if Path(config["cwd"]).joinpath("unknown-resources").exists():
                hardware.pop("ram_used")
                hardware.pop("gpu_mem_used")
            if Path(config["cwd"]).joinpath("resource-pressure").exists():
                hardware["ram_used"] = hardware["ram_total"] - 128 * 2**20
                hardware["gpu_mem_used"] = hardware["gpu_mem_total"] - 128 * 2**20
            self.respond({"engine": engine,
                          "hardware":hardware,
                          "hardware_static": {"cpu": "fixture"},
                          "live": {"state": "generating" if active else "idle", "queued": 0,
                                   "running": active, "waiting": 0, "outside_slots": 0}})
        else:
            self.respond({})

    def do_POST(self):
        global loaded, active, counter
        request_id = str(time.time_ns())
        admitted = journal.admit(request_id, self.headers.get("X-Strata-Manager-Tuning-Id"))
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if admitted is False:
                self.respond({"error": {"code": "strata_manager_maintenance"}}, 503)
                return
            if self.path in ("/load", "/v1/load"):
                if (abs(pcie - 0.35) < 0.001 and Path(config["cwd"]).joinpath("reject-applied").exists()) or (workers == 3 and Path(config["cwd"]).joinpath("reject-restart").exists()):
                    self.respond({"error": {"code": "fixture_load_failure"}}, 500)
                else:
                    loaded = True
                    self.respond({"status": "loaded"})
                return
            if self.path in ("/unload", "/v1/unload"):
                loaded = False
                self.respond({"status": "unloaded"})
                return
            if self.path != "/v1/chat/completions":
                self.respond({})
                return
            request = json.loads(body)
            with counter_lock:
                active += 1
                counter += 1
                seen = counter
            try:
                tune = request.get("strata_tune", {})
                requested_pcie = tune.get("pcie_frac", pcie)
                # Controlled fixture timings, never representative GPU data.
                rate = 120 if abs(requested_pcie - 0.35) < 0.001 else (80 if requested_pcie < 0.3 else 100)
                answer = "完整固定回答，所有候选必须返回同样的文本。"
                tokens = 24
                if request["max_tokens"] == 32:
                    answer, tokens = "READY", 1
                elif request["max_tokens"] == 1024:
                    if workers == 2 and Path(config["cwd"]).joinpath("oom-candidate").exists():
                        os._exit(137)  # Simulated OOM of this test-owned process.
                    content = request["messages"][-1]["content"]
                    if "编号、负责人、数量" in content:
                        answer = json.dumps({"编号":"N7", "负责人":"Mira", "数量":5}, ensure_ascii=False)
                    elif "original ticket and owner" in content:
                        answer = json.dumps({"ticket":"N7", "owner":"Mira", "count":5})
                    elif "owner Theo" in content:
                        answer = json.dumps({"ticket":"Z9", "owner":"Theo", "count":8})
                    elif "values must contain all integers" in content:
                        answer = json.dumps({"values":list(range(1,129)), "total":8256})
                    else:
                        answer = json.dumps({"ticket":"N7", "owner":"Mira", "count":3})
                    time.sleep(.004 if workers == 2 or abs(requested_pcie - .35) < .001 else .035)
                    if Path(config["cwd"]).joinpath("slow-full").exists():
                        Path(config["cwd"]).joinpath("full-in-flight").write_text(str(workers))
                        time.sleep(1)
                time.sleep(0.012)
                if Path(config["cwd"]).joinpath("crash-request").exists():
                    os._exit(27)  # Only the test-owned Python process exits.
                events = [
                    {"choices": [{"delta": {"content": answer}, "finish_reason": None}]},
                    {"choices": [{"delta": {}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 120, "completion_tokens": tokens,
                               "prompt_tokens_details": {"cached_tokens": 110 if seen % 2 == 0 else 4}},
                     "timings": {"predicted_ms": tokens / rate * 1000, "predicted_per_second": rate,
                                 "prompt_ms": 1 if seen % 2 == 0 else 15}},
                ]
                payload = "".join("data: " + json.dumps(event, ensure_ascii=False) + "\n\n" for event in events)
                payload = (payload + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with counter_lock:
                    active -= 1
        finally:
            if admitted:
                journal.release(request_id)


ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
