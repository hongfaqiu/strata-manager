"""CPU-only MCP stdio/owner fixture. Uses no model, network except loopback TCP."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

role, directory, mode = sys.argv[1:4]
root = Path(directory)


def save(name, value):
    temporary = root / (name + ".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(root / name)


if role == "engine":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    save("engine.json", {"pid": os.getpid(), "port": listener.getsockname()[1]})
    while True:
        time.sleep(0.1)

elif role == "tool":
    child = subprocess.Popen([sys.executable, __file__, "engine", directory, mode],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    save("tool.json", {"pid": os.getpid(), "engine": child.pid})

    def terminate(signum, frame):
        save("term.json", {"grace": True})
        time.sleep(0.3)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate if mode == "grace" else signal.SIG_IGN)
    for line in sys.stdin.buffer:
        request = json.loads(line)
        if request.get("id") is not None:
            result = {"echo": request.get("params", {}).get("text"), "pid": os.getpid()}
            frame = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result},
                               ensure_ascii=False).encode("utf-8") + b"\n"
            sys.stdout.buffer.write(frame)
            sys.stdout.buffer.flush()
    # Other modes survive stdin EOF to exercise TERM/SIGKILL fallback.
    if mode != "natural":
        while True:
            time.sleep(0.1)

elif role == "owner":
    helper, resources, upstream = sys.argv[4:7]
    os.environ["STRATA_MANAGER_MCP_HELPER"] = helper
    sys.path[:0] = [resources, upstream]
    import strata_mcp_guard
    strata_mcp_guard.install()
    from serve.mcp import StdioTransport
    transport = StdioTransport("isolated-guardian", {
        "command": sys.executable,
        "args": [__file__, "tool", directory, mode],
        # A per-tool variable cannot replace the path captured by install().
        "env": {"STRATA_MANAGER_MCP_HELPER": "/nonexistent/override"},
    })
    transport.start()
    text = "青松 🌲\nquoted \"value\" " + "缓存" * 2048
    result = transport.request("echo", {"text": text}, 5)
    assert result["echo"] == text
    deadline = time.monotonic() + 5
    while not (root / "engine.json").exists():
        assert time.monotonic() < deadline
        time.sleep(0.02)
    save("ready.json", {"owner": os.getpid(), "wrapper": transport.proc.pid,
                        "tool": result["pid"], "echoBytes": len(text.encode("utf-8"))})
    while not (root / "close").exists():
        time.sleep(0.02)
    transport.close()
    save("closed.json", {"owner": os.getpid(), "stdioClosed": True})
    while True:
        time.sleep(0.1)

else:
    raise SystemExit("Unknown fixture role")
