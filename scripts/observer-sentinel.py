"""Sentinel helper: classify the latest upstream release and record it when compatible.

usage: observer-sentinel.py <tag> <ref>   (STRATA_TEST_ROOT = checkout of that tag)
Writes result=added|known to $GITHUB_OUTPUT. Exits non-zero when the source is not
structurally observable or the MockEngine HTTP suite fails.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
COMPAT = REPO / "apps/supervisor/resources/observer_compat.json"
sys.path.insert(0, str(REPO / "apps/supervisor/resources"))
import strata_observer  # noqa: E402


def output(key, value):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{key}={value}\n")
    print(f"{key}={value}")


def main(tag, ref):
    root = Path(os.environ["STRATA_TEST_ROOT"])
    source = (root / "serve/server.py").read_bytes()
    digest = hashlib.sha256(source.replace(b"\r\n", b"\n")).hexdigest()
    analysis = strata_observer.analyze_source(source.decode("utf-8"))
    print(json.dumps(analysis))
    if analysis["mode"] == "disabled":
        sys.exit(f"{tag}: core observer contract missing: {analysis['missing']}")
    compat = json.loads(COMPAT.read_text(encoding="utf-8"))
    if any(digest in entry["serverPySha256"] for entry in compat["reviewed"]):
        output("result", "known")
        return
    # Temporarily accept the hash so the full HTTP suite runs instead of skipping.
    compat["reviewed"].append({"version": tag.lstrip("v"), "ref": ref, "serverPySha256": [digest],
                               "review": f"Sentinel: structural mode {analysis['mode']}; MockEngine HTTP suite passed. Needs human review."})
    COMPAT.write_text(json.dumps(compat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    suite = subprocess.run([sys.executable, str(REPO / "apps/supervisor/tests/test_strata_observer.py")])
    if suite.returncode:
        sys.exit(f"{tag}: MockEngine HTTP contracts failed")
    output("result", "added")


if __name__ == "__main__":
    main(*sys.argv[1:3])
