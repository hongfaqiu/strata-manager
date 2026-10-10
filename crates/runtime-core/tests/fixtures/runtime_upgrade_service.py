"""Synthetic, isolated runtime-upgrade protocol fixture. Never loads an engine/GPU."""
import argparse
import json
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from strata_observer import Journal

parser = argparse.ArgumentParser()
parser.add_argument("--config")
parser.add_argument("--port", type=int)
parser.add_argument("--host")
args, _ = parser.parse_known_args()
config = json.loads(Path(args.config).read_text(encoding="utf-8"))
directory = Path(os.environ["STRATA_MANAGER_ANALYTICS_DIR"])
service_id = os.environ["STRATA_MANAGER_SERVICE_ID"]
journal = Journal(directory, service_id)
journal.status(True, "isolated-runtime-upgrade-fixture")
loaded = False
active = 0
shared_path = Path(str(Path(args.config).with_suffix("")) + ".shared-settings.json")


def shared_settings():
    return json.loads(shared_path.read_text(encoding="utf-8")) if shared_path.exists() else {}


def heartbeat():
    while True:
        time.sleep(0.1)
        journal.status(True, "isolated-runtime-upgrade-fixture")


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
            self.respond({"status": "ok", "service": "strata", "loaded": loaded,
                          "model": config["model_name"], "generation": config.get("fixture_generation", "old"),
                          "shared": shared_settings()})
        elif self.path == "/v1/status":
            self.respond({"service": "strata", "activity": {"in_flight": active}})
        elif self.path == "/metrics":
            self.respond({"engine": {"version": "fixture-only"}, "live": {
                "state": "generating" if active else "idle", "queued": 0, "running": active,
                "waiting": 0, "outside_slots": 0}})
        else:
            self.respond({})

    def do_POST(self):
        global loaded, active
        request_id = str(time.time_ns())
        admitted = journal.admit(request_id, self.headers.get("X-Strata-Manager-Maintenance-Token")
                                 or self.headers.get("X-Strata-Manager-Tuning-Id"))
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if admitted is False:
                self.respond({"error": "maintenance"}, 503)
                return
            if self.path == "/load":
                if config.get("fixture_slow_load"):
                    Path(config["cwd"]).joinpath("candidate-loading").write_text(str(os.getpid()))
                    time.sleep(15)
                if config.get("fixture_fail_load"):
                    self.respond({"error": "controlled candidate load rejection"}, 500)
                    return
                loaded = True
                self.respond({"status": "loaded"})
            elif self.path == "/unload":
                if config.get("fixture_unload_during_drain"):
                    Path(config["cwd"]).joinpath("old-unloading").write_text(str(os.getpid()))
                    deadline = time.monotonic() + 10
                    while not directory.joinpath(service_id + ".maintenance").exists():
                        if time.monotonic() > deadline:
                            self.respond({"error": "fixture expected a drain gate"}, 500)
                            return
                        time.sleep(0.01)
                    time.sleep(0.2)
                loaded = False
                self.respond({"status": "unloaded"})
            elif self.path == "/settings":
                request = json.loads(body)
                if request.get("fixture_wait_for_drain"):
                    Path(config["cwd"]).joinpath("old-saving-settings").write_text(str(os.getpid()))
                    deadline = time.monotonic() + 10
                    while not directory.joinpath(service_id + ".maintenance").exists():
                        if time.monotonic() > deadline:
                            self.respond({"error": "fixture expected a drain gate"}, 500)
                            return
                        time.sleep(0.01)
                    time.sleep(0.2)
                # Match official shared-settings persistence (write_text/unlink).
                if request.get("delete"):
                    shared_path.unlink(missing_ok=True)
                else:
                    shared_path.write_text(json.dumps(request["shared"], indent=1), encoding="utf-8")
                if request.get("fixture_edit_main_config"):
                    edited = dict(config, fixture_concurrent_main_edit=True)
                    Path(args.config).write_text(json.dumps(edited), encoding="utf-8")
                self.respond({"status": "saved", "shared": shared_settings()})
            elif self.path == "/v1/chat/completions":
                request = json.loads(body)
                if (request.get("model") != config["model_name"]
                        or request.get("chat_template_kwargs") != {"enable_thinking": False}
                        or request.get("strata_mcp") is not False
                        or request.get("tool_choice") != "none"):
                    self.respond({"error": "probe must use actual model, disable thinking and tools"}, 400)
                    return
                active += 1
                try:
                    if config.get("fixture_bad_probe"):
                        payload = b'data: {"error":{"message":"controlled probe rejection"}}\n\ndata: [DONE]\n\n'
                    else:
                        payload = (b'data: {"choices":[{"delta":{"content":"READY"},"finish_reason":null}]}\n\n'
                                   b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                                   b'data: [DONE]\n\n')
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                finally:
                    active -= 1
            else:
                self.respond({})
        finally:
            if admitted:
                journal.release(request_id)


ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
