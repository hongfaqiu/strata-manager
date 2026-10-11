"""Exercise the application-owned MCP bridge without changing a running model.

Example: py scripts/verify-manager-mcp.py --supervisor target/debug/strata-supervisor.exe
  --data-dir <absolute backend data directory> --profile-id <registered id>
  --evidence output/manager-mcp-readonly.json

The separate Rust integration test covers start/stop with an isolated CPU fixture.
"""
import argparse
import datetime
import json
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading


SECRET_KEY = re.compile(r"^(?:api[_-]?key|authorization|password|secret|credential|access[_-]?token)$", re.I)
SECRET_VALUE = re.compile(r"\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})", re.I)


def sanitize(value):
    if isinstance(value, dict):
        return {key: "[redacted]" if SECRET_KEY.match(key) else sanitize(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (ValueError, TypeError):
            return SECRET_VALUE.sub("[redacted]", value)
        if isinstance(decoded, (dict, list)):
            return json.dumps(sanitize(decoded), ensure_ascii=False)
        return SECRET_VALUE.sub("[redacted]", value)
    return value


class Bridge:
    def __init__(self, executable, data_dir, profile_id):
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
        self.child = subprocess.Popen(
            [str(executable), "--mcp-server", "--data-dir", str(data_dir), "--profile-id", profile_id],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", **flags)
        self.lines = queue.Queue()
        self.stderr = []
        self.next_id = 0

        def read_stdout():
            try:
                for line in self.child.stdout:
                    self.lines.put(json.loads(line))
            except Exception as error:
                self.lines.put(error)
            finally:
                self.lines.put(EOFError("MCP stdout closed"))

        def read_stderr():
            for line in self.child.stderr:
                if sum(map(len, self.stderr)) < 16384:
                    self.stderr.append(line)

        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=read_stderr, daemon=True).start()

    def request(self, method, params=None):
        self.next_id += 1
        identifier = self.next_id
        message = {"jsonrpc": "2.0", "id": identifier, "method": method}
        if params is not None:
            message["params"] = params
        self.child.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.child.stdin.flush()
        for _ in range(64):
            response = self.lines.get(timeout=30)
            if isinstance(response, Exception):
                raise response
            if response.get("id") == identifier:
                return response
        raise RuntimeError("Too many unrelated MCP messages")

    def initialize(self):
        response = self.request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "strata-manager-readonly-verification", "version": "1"}})
        self.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        self.child.stdin.flush()
        return response

    def tool(self, name, arguments=None):
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})

    def close(self):
        if self.child.stdin and not self.child.stdin.closed:
            self.child.stdin.close()
        try:
            code = self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait(timeout=5)
            raise RuntimeError("MCP process did not exit after stdin EOF")
        return {"exitCode": code, "stderr": "".join(self.stderr)}


def rejected(response):
    return "error" in response or response.get("result", {}).get("isError") is True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--supervisor", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    executable = args.supervisor.resolve(strict=True)
    data_dir = args.data_dir.resolve(strict=True)
    evidence = {"startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "executable": str(executable), "profileId": args.profile_id,
                "mode": "readonly", "checks": []}
    bridges = []

    def record(name, response, success=True):
        evidence["checks"].append({"name": name, "passed": success, "response": sanitize(response)})
        if not success:
            raise AssertionError(name)

    try:
        bridge = Bridge(executable, data_dir, args.profile_id)
        bridges.append(bridge)
        response = bridge.initialize()
        record("initialize", response, not rejected(response))
        response = bridge.request("tools/list")
        expected = {"strata_status", "strata_models", "strata_start", "strata_stop",
                    "strata_logs", "strata_install", "strata_connect_info", "strata_task_status"}
        actual = {tool["name"] for tool in response.get("result", {}).get("tools", [])}
        record("tools/list", response, actual == expected)
        for name in ("strata_status", "strata_models", "strata_connect_info", "strata_task_status"):
            response = bridge.tool(name)
            record(name, response, not rejected(response))
        for name, arguments in (
            ("not_a_registered_tool", {}),
            ("strata_status", {"profileId": "not-the-bound-profile"}),
            ("strata_status", {"profile": {"id": "injected", "installDir": "C:/"}}),
            ("strata_status", {"method": "shutdown_supervisor", "params": {}}),
            ("strata_status", {"path": "/load", "rpc": "stop_service"}),
            ("strata_logs", {"limit": 501}),
        ):
            response = bridge.tool(name, arguments)
            record("reject:" + name + ":" + ",".join(arguments), response, rejected(response))
        closed = bridge.close()
        bridges.remove(bridge)
        record("bridge-eof", closed, closed["exitCode"] == 0)
        bridge = Bridge(executable, data_dir, args.profile_id)
        bridges.append(bridge)
        bridge.initialize()
        response = bridge.tool("strata_status")
        record("backend-survives-bridge-eof", response, not rejected(response))
        record("reconnected-bridge-eof", bridge.close())
        bridges.remove(bridge)
        with tempfile.TemporaryDirectory(prefix="strata-mcp-backend-absent-") as missing:
            bridge = Bridge(executable, Path(missing), args.profile_id)
            bridges.append(bridge)
            response = bridge.initialize()
            # Some implementations surface the missing backend during initialize;
            # others keep initialize local and surface it on the first tool call.
            if not rejected(response):
                response = bridge.tool("strata_status")
            record("missing-backend-is-explicit-error", response, rejected(response))
            record("missing-backend-bridge-eof", bridge.close())
            bridges.remove(bridge)
        evidence["passed"] = True
    except Exception as error:
        evidence["passed"] = False
        evidence["failure"] = sanitize(str(error))
        raise
    finally:
        for bridge in bridges:
            try:
                bridge.close()
            except Exception:
                pass
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"passed": evidence.get("passed", False), "evidence": str(args.evidence.resolve())}))


if __name__ == "__main__":
    main()
