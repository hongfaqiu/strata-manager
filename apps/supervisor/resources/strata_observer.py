"""Strata Manager's optional metadata observer (Python standard library).

Loaded from an application-owned sitecustomize directory. Original Strata files,
generation payloads and original configuration are never changed. Live metrics
include the observed load state; durable journals
contain metadata only. An explicit application lease can temporarily retain the
official bounded body records in RAM, with automatic erase; manually enabled
upstream monitoring remains entirely under the user's control.
"""
from __future__ import annotations

import ast
import atexit
import collections
import functools
import hashlib
import hmac
import importlib.abc
import importlib.machinery
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
import uuid
import weakref
from urllib.parse import parse_qs, urlsplit

SCHEMA_VERSION = 1
COMPAT_FILE = Path(__file__).with_name("observer_compat.json")


def _load_reviewed_hashes(path=COMPAT_FILE):
    """Reviewed upstream server.py hashes from observer_compat.json (the single source of truth).

    A missing or damaged file only removes the reviewed fast path; unknown sources
    are still analysed structurally, so analytics never depends on this list alone."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return frozenset(h for entry in data.get("reviewed", []) for h in entry.get("serverPySha256", [])
                         if isinstance(h, str) and re.fullmatch(r"[0-9a-f]{64}", h))
    except (OSError, ValueError, AttributeError, TypeError):
        return frozenset()


SUPPORTED_HASHES = _load_reviewed_hashes()

# Structural contract the observer wraps. Each capability lists (owner, method, accepted signatures).
_RUN_ARGS = "self, ids, thinking, tools, max_new, sampling, cancel, force=None"
# Strata 0.2.2 adds declared_only (MCP and tool routes pass it by keyword); the wrapper forwards it.
_RUN_ARGS_022 = _RUN_ARGS + ", declared_only=False"
CORE_SERVICE = {"run": {_RUN_ARGS, _RUN_ARGS_022}, "_note": {"self, n, evs, st=None, rate=None"},
                "begin_request": {"self, path, req"}}
CORE_HANDLER = {"do_POST": {"self"}, "do_GET": {"self"}, "send_response": {"self, code, message=None"},
                "_note": {"self, **values"}, "_json": {"self, code, obj", "self, code, obj, headers=None",
                          "self, code, obj, headers=None, retry_after=None"},
                "_capture": {"self, items, api"}}
OPTIONAL = ("load_state", "expert_stats", "mcp")


def _methods(node):
    return {n.name: ast.unparse(n.args) for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def analyze_source(source):
    """Classify an upstream serve/server.py without importing or running it.

    Returns {"mode": "structural"|"partial"|"disabled", "capabilities": {...}, "missing": [...]}.
    core = request accounting (Service.run/_note/begin_request and the HTTP handler
    methods with the exact signatures the wrappers forward). Optional capabilities
    degrade one by one; a missing core disables the observer (public endpoints remain)."""
    try:
        module = ast.parse(source)
    except (SyntaxError, ValueError):
        return {"mode": "disabled", "capabilities": {"core": False, **{k: False for k in OPTIONAL}}, "missing": ["parse"]}
    top = {n.name: n for n in module.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))}
    missing = []
    service = top.get("Service")
    service_methods = _methods(service) if isinstance(service, ast.ClassDef) else {}
    for name, accepted in CORE_SERVICE.items():
        if service_methods.get(name) not in accepted:
            missing.append("Service." + name)
    factory = top.get("make_handler")
    handler = next((n for n in factory.body if isinstance(n, ast.ClassDef)), None) if isinstance(factory, ast.FunctionDef) else None
    handler_methods = _methods(handler) if handler is not None else {}
    for name, accepted in CORE_HANDLER.items():
        if handler_methods.get(name) not in accepted:
            missing.append("Handler." + name)
    routes_present = all(repr(route)[1:-1] in source for route in ROUTES)
    if not routes_present:
        missing.append("routes")
    core = not missing
    caps = {"core": core,
            "load_state": "ensure_loaded" in service_methods and "metrics" in service_methods,
            "expert_stats": isinstance(top.get("request_stats"), ast.FunctionDef),
            "mcp": isinstance(top.get("run_with_mcp"), ast.FunctionDef)}
    missing += [k for k in OPTIONAL if not caps[k]]
    mode = "disabled" if not core else "structural" if all(caps[k] for k in OPTIONAL) else "partial"
    return {"mode": mode, "capabilities": caps, "missing": missing}


ROUTES = {"/v1/chat/completions": "chat", "/v1/responses": "responses",
          "/v1/messages": "anthropic", "/v1/messages/count_tokens": "token_count"}
MODEL_CONTROL_ROUTES = {"/load", "/unload", "/settings", "/config",
                        "/v1/load", "/v1/unload", "/v1/vram"}
_local = threading.local()
_journal = None
_captures = weakref.WeakSet()


def _number(value, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return min(int(value), 2**53 - 1) if integer else float(value)


def _error_kind(value):
    if not isinstance(value, dict):
        return "api_error"
    kind = value.get("type") or value.get("code")
    return kind if kind in {"invalid_request_error", "server_error", "model_busy", "api_error",
                           "structured_output_failed", "authentication_error", "not_found"} else "api_error"


class Journal:
    """SQLite WAL sequence journal; the supervisor ACKs only after durable import."""
    def __init__(self, directory, service_id, max_events=200000, retention_days=7):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "journal.sqlite3"
        self.service_id = service_id
        self.session_id = uuid.uuid4().hex
        self.max_events = max(32, int(max_events))
        self.retention_ms = max(1, int(retention_days)) * 86400000
        self.lock = threading.RLock()
        self.failed = False
        self.closed = False
        self.db = sqlite3.connect(self.path, timeout=5, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA wal_autocheckpoint=512")
        self.db.execute("PRAGMA journal_size_limit=16777216")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,at_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS active_requests(
                request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,
                session_id TEXT NOT NULL,started_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS service_activity(
                service_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
                last_activity_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS request_capture_leases(service_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS request_capture_status(service_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            INSERT OR IGNORE INTO meta VALUES('ack','0');
            INSERT OR IGNORE INTO meta VALUES('dropped_through','0');
            INSERT OR IGNORE INTO meta VALUES('schema_version','1');
        """)
        self.db.execute("INSERT OR IGNORE INTO meta VALUES('source_id',?)", (uuid.uuid4().hex,))
        # The supervisor guarantees one process per installation. A fresh
        # observer session replaces stale admission entries from a crashed one.
        self.db.execute("DELETE FROM active_requests WHERE service_id=?", (service_id,))
        self.db.execute("INSERT INTO service_activity VALUES(?,?,0,?) "
                        "ON CONFLICT(service_id) DO UPDATE SET session_id=excluded.session_id,"
                        "revision=0,last_activity_ms=excluded.last_activity_ms",
                        (service_id,self.session_id,int(time.time()*1000)))
        self.db.commit()
        self._activity_requests = set()
        self.status_path = self.directory / ("status-" + service_id + ".json")
        self._writes = 0

    def _write_failed(self):
        if not self.failed:
            self.failed = True
            print("[strata-manager] analytics journal write failed; coverage is incomplete",
                  file=sys.stderr, flush=True)
            self.status(False, error="journal_write_failed")

    def _touch_activity(self):
        # One metadata-only row per service. Session ownership prevents a late
        # completion from the old observer from changing a replacement session.
        changed = self.db.execute("UPDATE service_activity SET revision=revision+1,"
                                  "last_activity_ms=? WHERE service_id=? AND session_id=?",
                                  (int(time.time()*1000),self.service_id,self.session_id)).rowcount
        if changed != 1:
            raise sqlite3.DatabaseError("activity session changed")

    def admit(self, request_id, tuning_token=None, activity=True):
        """Linearized with supervisor maintenance creation under BEGIN IMMEDIATE.

        The optional maintenance token is only compared, never journaled. None
        denotes failed observability: normal API behavior stays available, while
        the supervisor must refuse a supposedly drained update/tuning operation.
        """
        try:
            with self.lock:
                self.db.execute("BEGIN IMMEDIATE")
                gate = self.directory / (self.service_id + ".maintenance")
                allowed = True
                if gate.exists():
                    allowed = False
                    try:
                        if gate.stat().st_size <= 4096:
                            value = json.loads(gate.read_text(encoding="utf-8"))
                            token = value.get("token") if isinstance(value, dict) else None
                            allowed = isinstance(value,dict) and value.get("mode") in {"tuning", "drain"} and isinstance(token,str) and len(token)>=32 and isinstance(tuning_token,str) and hmac.compare_digest(token,tuning_token)
                    except (OSError,ValueError,TypeError):
                        pass  # Any malformed maintenance marker fails closed.
                if allowed:
                    self.db.execute("INSERT INTO active_requests VALUES(?,?,?,?)",
                                    (request_id,self.service_id,self.session_id,int(time.time()*1000)))
                    if activity:
                        self._touch_activity()
                self.db.commit()
                if allowed and activity:
                    self._activity_requests.add(request_id)
                return allowed
        except (sqlite3.Error,OSError):
            try:
                self.db.rollback()
            except sqlite3.Error:
                pass
            self._write_failed()
            return None

    def release(self, request_id):
        try:
            with self.lock:
                self.db.execute("BEGIN IMMEDIATE")
                changed = self.db.execute("DELETE FROM active_requests WHERE request_id=? "
                                          "AND service_id=? AND session_id=?",
                                          (request_id,self.service_id,self.session_id)).rowcount
                if changed and request_id in self._activity_requests:
                    self._touch_activity()
                self.db.commit()
                self._activity_requests.discard(request_id)
        except sqlite3.Error:
            try:
                self.db.rollback()
            except sqlite3.Error:
                pass
            self._write_failed()

    def status(self, supported, source_hash=None, error=None):
        # No exception text: upstream exceptions can contain request material.
        record = {"schemaVersion": 1, "serviceId": self.service_id, "sessionId": self.session_id,
                  "pid": os.getpid(), "updatedAtMs": int(time.time()*1000),
                  "supported": bool(supported), "sourceHash": source_hash,
                  "error": error, "journalWriteFailed": self.failed,
                  "observerActive": bool(supported) and not self.failed and not self.closed,
                  "observerMode": getattr(self, "mode", None), "capabilities": getattr(self, "capabilities", None)}
        try:
            temp = self.status_path.with_suffix(".tmp")
            temp.write_text(json.dumps(record, separators=(",", ":")), encoding="utf-8")
            os.replace(temp, self.status_path)
        except OSError:
            print("[strata-manager] analytics status could not be persisted", file=sys.stderr, flush=True)

    def append(self, kind, payload):
        """Instrumentation failure must not turn a successful API call into an error."""
        if self.closed:
            return False
        try:
            with self.lock:
                self.db.execute("INSERT INTO events(at_ms,kind,payload) VALUES(?,?,?)",
                                (int(time.time()*1000), kind,
                                 json.dumps(payload, separators=(",", ":"), allow_nan=False)))
                self._writes += 1
                if self._writes % 128 == 0:
                    self._trim()
                self.db.commit()
            return True
        except (sqlite3.Error, ValueError, OSError):
            with self.lock:
                try:
                    self.db.rollback()
                except sqlite3.Error:
                    pass
            self._write_failed()
            return False

    def close(self):
        with self.lock:
            self.closed = True
            self.db.close()

    def _trim(self):
        ack = int(self.db.execute("SELECT value FROM meta WHERE key='ack'").fetchone()[0])
        cutoff = int(time.time()*1000) - self.retention_ms
        expired = self.db.execute("SELECT MAX(seq) FROM events WHERE at_ms<?", (cutoff,)).fetchone()[0]
        if expired is not None:
            if expired > ack:
                self.db.execute("UPDATE meta SET value=CAST(MAX(CAST(value AS INTEGER),?) AS TEXT) WHERE key='dropped_through'", (expired,))
            self.db.execute("DELETE FROM events WHERE seq<=?", (expired,))
        row = self.db.execute("SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?",
                              (self.max_events - 1,)).fetchone()
        if row:
            through = row[0] - 1
            # Unacknowledged eviction is an explicit, durable collection gap.
            if through > ack:
                self.db.execute("UPDATE meta SET value=? WHERE key='dropped_through'", (str(through),))
            self.db.execute("DELETE FROM events WHERE seq<=?", (through,))
        # Bounded WAL: checkpoint regularly; readers may defer truncation safely.
        # Run outside the current transaction after commit (append handles it).


def _ctx():
    return getattr(_local, "request", None)


def _usage(ctx, value):
    if ctx is None or not isinstance(value, dict):
        return
    if ctx["route"] == "anthropic":
        fresh = _number(value.get("input_tokens"), True)
        cached = _number(value.get("cache_read_input_tokens"), True)
        created = _number(value.get("cache_creation_input_tokens"), True)
        # message_start initially reports the total; message_delta replaces it
        # with fresh + cache. Merge missing fields but replace present fields.
        if fresh is not None:
            ctx["usageFresh"] = fresh
        if cached is not None:
            ctx["cacheReadTokens"] = cached
        if created is not None:
            ctx["cacheCreationTokens"] = created
        if ctx.get("usageFresh") is not None:
            ctx["inputTokens"] = ctx["usageFresh"] + (ctx.get("cacheReadTokens") or 0) + (ctx.get("cacheCreationTokens") or 0)
        output = _number(value.get("output_tokens"), True)
    else:
        input_key = "input_tokens" if ctx["route"] == "responses" else "prompt_tokens"
        output_key = "output_tokens" if ctx["route"] == "responses" else "completion_tokens"
        incoming = _number(value.get(input_key), True)
        if incoming is not None:
            ctx["inputTokens"] = incoming
        details = value.get("input_tokens_details" if ctx["route"] == "responses" else "prompt_tokens_details")
        if isinstance(details, dict):
            cached = _number(details.get("cached_tokens"), True)
            if cached is not None:
                ctx["cacheReadTokens"] = cached
        output = _number(value.get(output_key), True)
    if output is not None:
        ctx["outputTokens"] = output


def _inspect_item(ctx, item, api):
    if not ctx or item is None:
        return
    if api == "anthropic" and isinstance(item, tuple) and len(item) == 2:
        item = item[1]
    if not isinstance(item, dict):
        return
    if item.get("error") or item.get("type") == "response.failed":
        ctx["errorKind"] = _error_kind(item.get("error") or (item.get("response") or {}).get("error"))
    message = item.get("message")
    response = item.get("response")
    for container in (item, message, response):
        if isinstance(container, dict):
            _usage(ctx, container.get("usage"))


class RequestCapture:
    """An expiring, application-owned body viewer; the upstream flag is never changed.

    Only lease metadata is durable. Bodies use the upstream bounded in-memory
    records and are erased on disable, expiry, identity change or a DB failure.
    Existing manual monitoring belongs to the user and is never claimed.
    """
    def __init__(self, svc, journal, source_hash):
        self.svc = weakref.ref(svc)
        self.journal, self.source_hash = journal, source_hash
        self.lock = threading.RLock()
        self.token, self.expires, self.deadline = None, 0, 0
        self.active_records = {}
        self.revoked = collections.deque(maxlen=128)
        self.last_wall = int(time.time()*1000)
        self.last_poll = 0
        _captures.add(self)
        self.refresh()

    def erase(self, svc):
        if self.token:
            self.revoked.append(self.token)
        with svc.status_lock:
            records = list(svc.api_requests) + list(self.active_records.values())
            for record in records:
                if record.get("_manager_capture_token"):
                    for key in ("input", "output", "reasoning", "response", "error"):
                        record.pop(key, None)
                    # Preserve lifecycle keys still used by the upstream's finally.
                    record["_manager_capture_erased"] = True
            svc.api_requests = type(svc.api_requests)(
                (r for r in svc.api_requests if not r.get("_manager_capture_token")), maxlen=100)
        self.token, self.expires, self.deadline = None, 0, 0

    def refresh(self, force=False):
        with self.lock:
            svc = self.svc()
            if svc is None or self.journal.closed:
                return False
            now = int(time.time()*1000)
            clock = time.monotonic()
            if (not force and clock-self.last_poll < 0.05 and now >= self.last_wall-1000
                    and svc.api_monitor is not True and (not self.token or (now < self.expires and clock < self.deadline))):
                return bool(self.token)
            self.last_poll = clock
            error = None
            lease = None
            try:
                with self.journal.lock:
                    row = self.journal.db.execute("SELECT payload FROM request_capture_leases WHERE service_id=?",
                                                  (self.journal.service_id,)).fetchone()
                if row:
                    if len(row[0]) > 4096:
                        raise ValueError()
                    lease = json.loads(row[0])
                    valid = (isinstance(lease, dict) and set(lease) == {
                        "protocolVersion", "serviceId", "sessionId", "pid", "sourceHash", "token", "createdAtMs", "expiresAtMs"}
                        and lease["protocolVersion"] == 1 and lease["serviceId"] == self.journal.service_id
                        and lease["sessionId"] == self.journal.session_id and lease["pid"] == os.getpid()
                        and lease["sourceHash"] == self.source_hash
                        and isinstance(lease["token"], str) and re.fullmatch(r"[a-f0-9]{32}", lease["token"])
                        and lease["token"] not in self.revoked
                        and type(lease["createdAtMs"]) is int and type(lease["expiresAtMs"]) is int
                        and 0 < lease["expiresAtMs"]-lease["createdAtMs"] <= 1800000
                        and lease["createdAtMs"] <= now + 1000 and now < lease["expiresAtMs"]
                        and now >= self.last_wall - 1000)
                    if not valid:
                        lease = None
                        error = "capture_lease_invalid_or_expired"
            except (sqlite3.Error, ValueError, TypeError, KeyError, OSError):
                error = "capture_lease_unavailable"
                lease = None
            manual = svc.api_monitor is True
            if manual or lease is None or (self.token == lease["token"] and time.monotonic() >= self.deadline):
                if self.token:
                    self.erase(svc)
                lease = None
            elif self.token != lease["token"]:
                if self.token:
                    self.erase(svc)
                self.token, self.expires = lease["token"], lease["expiresAtMs"]
                self.deadline = time.monotonic() + min(1800, (self.expires-now)/1000)
            self.last_wall = now
            status = {"protocolVersion": 1, "serviceId": self.journal.service_id,
                      "sessionId": self.journal.session_id, "pid": os.getpid(), "sourceHash": self.source_hash,
                      "updatedAtMs": now, "manualEnabled": manual, "active": bool(self.token),
                      "token": self.token, "expiresAtMs": self.expires if self.token else None, "error": error}
            try:
                with self.journal.lock:
                    self.journal.db.execute("INSERT INTO request_capture_status VALUES(?,?) ON CONFLICT(service_id) DO UPDATE SET payload=excluded.payload",
                                            (self.journal.service_id, json.dumps(status, separators=(",", ":"))))
                    self.journal.db.commit()
            except sqlite3.Error:
                if self.token:
                    self.erase(svc)
                return False
            return bool(self.token)

    def begin(self, path, req):
        with self.lock:
            svc = self.svc()
            if svc is None or not self.refresh():
                return None
            # Exact verified upstream record format and 256 KiB limits. Unlike
            # toggling api_monitor around begin_request, this has no global race.
            raw = json.dumps(req, ensure_ascii=False, indent=2)
            record = {"id": uuid.uuid4().hex[:12], "path": path, "model": req.get("model") or svc.model,
                      "started_at": time.time(), "state": "queued", "stream": bool(req.get("stream")),
                      "response_format": (req.get("response_format") or {}).get("type") if isinstance(req.get("response_format"), dict) else None,
                      "input": raw[:262144], "input_truncated": len(raw) > 262144,
                      "output": "", "reasoning": "", "output_truncated": False, "reasoning_truncated": False,
                      "queue_s": 0.0, "load_s": 0.0, "first_token_s": None, "_clock": time.perf_counter(),
                      "_manager_capture_token": self.token}
            with svc.status_lock:
                svc.api_requests.append(record)
            svc.request_trace.record = record
            self.active_records[threading.get_ident()] = record
            return record

    def allowed_record(self, handler):
        self.refresh()
        record = getattr(handler, "record", None)
        if record is not None and record.get("_manager_capture_token"):
            if not self.token or record.get("_manager_capture_token") != self.token or record.get("_manager_capture_erased"):
                handler.record = None
                return False
        return True


def instrument_globals(namespace, journal=None, source_hash=None, allow_fixture=False, analysis=None):
    """Executed immediately before the official module's main guard."""
    global _journal
    if namespace.get("_strata_manager_instrumented"):
        return
    service = namespace.get("Service")
    make_handler = namespace.get("make_handler")
    if journal is None:
        journal = _journal
    if journal is None:
        return
    reviewed = source_hash in SUPPORTED_HASHES or allow_fixture
    if reviewed:
        mode, caps = "reviewed", {"core": True, **{k: True for k in OPTIONAL}}
    else:
        analysis = analysis if isinstance(analysis, dict) else {"mode": "disabled", "capabilities": {}}
        mode = analysis.get("mode") if analysis.get("mode") in ("structural", "partial") else "disabled"
        caps = {k: bool(analysis.get("capabilities", {}).get(k)) for k in ("core", *OPTIONAL)}
    runtime_ok = service is not None and callable(make_handler) and all(
        callable(getattr(service, name, None)) for name in ("run", "_note", "begin_request"))
    if not runtime_ok:
        mode, caps = "disabled", {k: False for k in ("core", *OPTIONAL)}
    supported = mode != "disabled"
    journal.mode, journal.capabilities = mode, caps
    journal.status(supported, source_hash, None if supported else "unsupported_runtime")
    journal.append("session_start", {"sessionId": journal.session_id, "serviceId": journal.service_id,
                    "startedAtMs": int(time.time()*1000), "supported": bool(supported),
                    "sourceHash": source_hash, "observerMode": mode})
    if not supported:
        print("[strata-manager] this Strata version does not match the observer contract; analytics are off, "
              "public /health /status /metrics remain and the API is unchanged", file=sys.stderr, flush=True)
        return
    if mode != "reviewed":
        print("[strata-manager] unreviewed Strata source: analytics run in %s mode (%s)"
              % (mode, ", ".join(k for k in OPTIONAL if not caps[k]) or "all capabilities present"),
              file=sys.stderr, flush=True)
    namespace["_strata_manager_instrumented"] = True
    original_run, original_note, original_begin = service.run, service._note, service.begin_request

    original_load = getattr(service, "ensure_loaded", None)
    original_metrics = getattr(service, "metrics", None)
    if caps["load_state"] and callable(original_load) and callable(original_metrics):
        # ensure_loaded runs under the upstream FIFO. Observe the actual load,
        # rather than requests waiting for it or an idle, unloaded engine. Keep
        # this metadata independent of optional request-body capture and of the
        # durable analytics journal, whose failures must not hide a live load.
        loading_lock = threading.RLock()
        loading = weakref.WeakKeyDictionary()

        @functools.wraps(original_load)
        def observed_load(self, *args, **kwargs):
            token = None
            try:
                vision_down = getattr(self, "_vision_down", None)
                if self.loaded() is not True or (callable(vision_down) and vision_down()):
                    candidate = object()
                    with loading_lock:
                        loading.setdefault(self, {})[candidate] = time.monotonic()
                        token = candidate
            except Exception:
                pass  # Observability must not alter upstream load/error behavior.
            try:
                return original_load(self, *args, **kwargs)
            finally:
                if token is not None:
                    with loading_lock:
                        active = loading.get(self)
                        if active is not None:
                            active.pop(token, None)
                            if not active:
                                loading.pop(self, None)

        @functools.wraps(original_metrics)
        def observed_metrics(self, *args, **kwargs):
            result = original_metrics(self, *args, **kwargs)
            with loading_lock:
                active = loading.get(self)
                if active and isinstance(result, dict) and isinstance(result.get("live"), dict):
                    # The engine has no load percentage. Expose elapsed time
                    # only, and leave the original upstream response untouched.
                    elapsed = round(max(0, time.monotonic() - min(active.values())), 1)
                    result = {**result, "live": {**result["live"], "state": "loading",
                              "phase": "loading model", "load_elapsed_s": elapsed}}
            return result

        service.ensure_loaded, service.metrics = observed_load, observed_metrics

    original_stats = namespace.get("request_stats")
    if caps["expert_stats"] and callable(original_stats):
        @functools.wraps(original_stats)
        def observed_stats(segments):
            values = original_stats(segments)
            current = getattr(_local, "run", None)
            if current is not None and isinstance(values, dict):
                # request_stats runs while the upstream still owns this request's
                # FIFO/slot. Reading the shared engine.last afterwards could
                # accidentally attribute the next request's expert-cache figures.
                current["expertCacheHits"] = _number(values.get("hits"), True)
                current["expertCacheLookups"] = _number(values.get("lookups"), True)
            return values
        namespace["request_stats"] = observed_stats

    def observed_model(svc):
        """The loaded service identity, never an untrusted request model/alias."""
        try:
            name = getattr(svc, "model", None)
            loaded = getattr(svc, "loaded", None)
            if (callable(loaded) and loaded() is True and isinstance(name, str)
                    and not re.match(r"^[A-Za-z]:[\\/]", name)
                    and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,159}", name)):
                return name
        except Exception:
            pass  # Observability must not change request behavior.
        return None

    @functools.wraps(original_begin)
    def begin(self, path, req):
        ctx = _ctx()
        if ctx:
            ctx["stream"] = bool(req.get("stream"))
        capture = getattr(self, "_manager_capture", None)
        if capture is not None and self.api_monitor is not True:
            return capture.begin(path, req)
        return original_begin(self, path, req)

    @functools.wraps(original_note)
    def note(self, n, *args, **kwargs):
        ctx, run = _ctx(), getattr(_local, "run", None)
        if run:
            run["outputTokens"] = _number(n, True)
            if n and run.get("firstTokenS") is None:
                run["firstTokenS"] = time.perf_counter() - run["clock"]
                if ctx and ctx.get("firstTokenS") is None:
                    ctx["firstTokenS"] = time.perf_counter() - ctx["clock"]
        return original_note(self, n, *args, **kwargs)

    @functools.wraps(original_run)
    def run(self, ids, thinking, tools, max_new, sampling, cancel, force=None, **extra):
        # extra carries keywords newer sources accept (0.2.2 declared_only); older sources
        # never receive one because their callers never pass it.
        ctx = _ctx()
        if not ctx:
            yield from original_run(self, ids, thinking, tools, max_new, sampling, cancel, force, **extra)
            return
        # A lazy model may have become ready after HTTP admission. Record only
        # its verified loaded service identity; failed loads remain unknown.
        actual_model = observed_model(self)
        if actual_model is not None:
            ctx["modelId"] = actual_model
        clock = time.perf_counter()
        info = {"runId": uuid.uuid4().hex, "requestId": ctx["requestId"], "sessionId": journal.session_id,
                "serviceId": journal.service_id, "startedAtMs": int(time.time()*1000),
                "promptTotal": len(ids), "inputTokens": None, "outputTokens": 0,
                "cacheReadTokens": None, "firstTokenS": None, "decodeTokS": None,
                "prefillTokens": None, "prefillS": None, "prefillTokS": None, "decodeS": None,
                "expertCacheHits": None, "expertCacheLookups": None,
                "finish": "interrupted", "toolCalls": 0, "clock": clock}
        previous_run = getattr(_local, "run", None)
        _local.run = info
        started = {key: value for key, value in info.items() if key != "clock"}
        started.update(finish="pending", outputTokens=None, durationS=None)
        journal.append("run_start", started)
        generator = original_run(self, ids, thinking, tools, max_new, sampling, cancel, force, **extra)
        try:
            for kind, value in generator:
                if kind == "event" and getattr(value, "kind", None) == "tool_call":
                    info["toolCalls"] += 1
                if kind == "done" and isinstance(value, dict):
                    finish = value.get("finish")
                    info["finish"] = finish if finish in {"stop", "length", "cancel", "disconnect", "error"} else "interrupted"
                    info["outputTokens"] = _number(value.get("completion_tokens"), True)
                    timings = value.get("timings") or {}
                    if isinstance(timings, dict):
                        prompt, cached = _number(timings.get("prompt_n"), True), _number(timings.get("cache_n"), True)
                        info["inputTokens"] = prompt + (cached or 0) if prompt is not None else (
                            len(ids) if info["finish"] not in {"cancel", "disconnect", "error"} else None)
                        info["cacheReadTokens"] = cached
                        info["decodeTokS"] = _number(timings.get("predicted_per_second"))
                        info["prefillTokens"] = prompt
                        prompt_ms = _number(timings.get("prompt_ms"))
                        decode_ms = _number(timings.get("predicted_ms"))
                        info["prefillS"] = prompt_ms / 1000 if prompt_ms is not None else None
                        info["decodeS"] = decode_ms / 1000 if decode_ms is not None else None
                        # Use engine timings rather than request wall time, which
                        # also includes queueing, loading, tools and decoding.
                        info["prefillTokS"] = _number(timings.get("prompt_per_second"))
                        if info["prefillTokS"] is None and prompt and prompt_ms:
                            info["prefillTokS"] = prompt * 1000 / prompt_ms
                    if info["finish"] in {"cancel", "disconnect"}:
                        ctx["cancelled"] = True
                    elif info["finish"] == "error":
                        ctx["errorKind"] = "server_error"
                yield kind, value
        except GeneratorExit:
            info["finish"] = "disconnect"
            ctx["cancelled"] = True
            raise
        except BaseException:
            info["finish"] = "error"
            ctx["errorKind"] = "server_error"
            raise
        finally:
            try:
                generator.close()
            finally:
                if cancel.is_set():
                    ctx["cancelled"] = True
                    if info["finish"] == "interrupted":
                        info["finish"] = "cancel"
                info["durationS"] = time.perf_counter() - clock
                info.pop("clock")
                journal.append("run_end", info)
                _local.run = previous_run

    service.run, service._note, service.begin_request = run, note, begin
    original_mcp = namespace.get("run_with_mcp")
    if caps["mcp"] and callable(original_mcp):
        @functools.wraps(original_mcp)
        def mcp(*args, **kwargs):
            generator = original_mcp(*args, **kwargs)
            try:
                for kind, value in generator:
                    ctx = _ctx()
                    if ctx and kind == "mcp" and isinstance(value, dict):
                        if value.get("event") == "call":
                            ctx["mcpToolCalls"] += 1
                        elif value.get("event") == "result" and not value.get("skipped"):
                            ctx["mcpToolFailures"] += not bool(value.get("ok"))
                    yield kind, value
            finally:
                generator.close()
        namespace["run_with_mcp"] = mcp

    @functools.wraps(make_handler)
    def observed_handler(svc):
        handler = make_handler(svc)
        capture_control = getattr(svc, "_manager_capture", None)
        if capture_control is None and all(hasattr(svc, name) for name in ("api_monitor", "api_requests", "status_lock", "request_trace")):
            capture_control = svc._manager_capture = RequestCapture(svc, journal, source_hash)
        post, send, handler_note = handler.do_POST, handler.send_response, handler._note
        emit_json, capture = handler._json, handler._capture
        get = handler.do_GET

        @functools.wraps(get)
        def observed_get(self):
            if (self.path.partition("?")[0].rstrip("/") == "/api/requests" and svc.api_monitor is not True
                    and capture_control is not None):
                with capture_control.lock:
                    enabled = capture_control.refresh()
                if enabled:
                    if self._authorized():
                        with capture_control.lock:
                            if not capture_control.refresh(force=True):
                                return get(self)
                            request_id = parse_qs(urlsplit(self.path).query).get("id", [None])[0]
                            records = svc.request_records(request_id)
                        return self._json(404 if records is None else 200,
                            {"error": {"message": "request no longer retained"}} if records is None else records if request_id else
                            {"requests": records, "retention": 100, "persistent": False, "loaded": svc.loaded(),
                             "auto_load": hasattr(svc.engine, "restart")})
                    return
            return get(self)

        @functools.wraps(post)
        def observed_post(self):
            path = self.path.partition("?")[0].rstrip("/")
            route = ROUTES.get(path)
            if route is None:
                request_id = uuid.uuid4().hex
                admission = journal.admit(request_id,self.headers.get("X-Strata-Manager-Maintenance-Token") or self.headers.get("X-Strata-Manager-Tuning-Id"),
                                          activity=path in MODEL_CONTROL_ROUTES or path.startswith("/slots/"))
                try:
                    if admission is False:
                        return self._json(503,{"error":{"type":"server_error","code":"strata_manager_maintenance","message":"The local service is being maintained. Retry shortly."}})
                    return post(self)
                finally:
                    if admission:
                        journal.release(request_id)
            client = self.headers.get("X-Strata-Client")
            if not client or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}", client):
                client = None
            ctx = {"requestId": uuid.uuid4().hex, "sessionId": journal.session_id,
                   "serviceId": journal.service_id, "startedAtMs": int(time.time()*1000),
                   "route": route, "clientId": client, "modelId": observed_model(svc), "stream": False, "httpStatus": None,
                   "inputTokens": None, "outputTokens": None, "cacheReadTokens": None,
                   "cacheCreationTokens": None, "firstTokenS": None, "errorKind": None,
                   "mcpToolCalls": 0, "mcpToolFailures": 0, "cancelled": False,
                   "clock": time.perf_counter()}
            self._manager_context = ctx
            previous = _ctx()
            _local.request = ctx
            journal.append("request_start", {key: ctx[key] for key in
                           ("requestId", "sessionId", "serviceId", "startedAtMs", "route", "clientId", "modelId")})
            admission = journal.admit(ctx["requestId"],self.headers.get("X-Strata-Manager-Maintenance-Token") or self.headers.get("X-Strata-Manager-Tuning-Id"))
            try:
                if admission is False:
                    return self._json(503,{"error":{"type":"server_error","code":"strata_manager_maintenance","message":"The local service is being maintained. Retry shortly."}})
                return post(self)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                ctx["cancelled"] = True
                raise
            except BaseException:
                ctx["errorKind"] = "server_error"
                raise
            finally:
                ctx["endedAtMs"] = int(time.time()*1000)
                ctx["durationS"] = time.perf_counter() - ctx.pop("clock")
                status = ctx["httpStatus"]
                ctx["outcome"] = "cancelled" if ctx.pop("cancelled") else (
                    "failed" if ctx["errorKind"] or status is None or status >= 400 else "succeeded")
                ctx.pop("usageFresh", None)
                journal.append("request_end", ctx)
                if admission:
                    journal.release(ctx["requestId"])
                _local.request = previous
                self._manager_context = None
                if capture_control is not None:
                    with capture_control.lock:
                        capture_control.active_records.pop(threading.get_ident(), None)

        @functools.wraps(send)
        def observed_send(self, code, message=None):
            ctx = getattr(self, "_manager_context", None)
            if ctx:
                ctx["httpStatus"] = int(code)
            return send(self, code, message)

        @functools.wraps(handler_note)
        def observed_note(self, **values):
            ctx = getattr(self, "_manager_context", None)
            if ctx:
                if values.get("error"):
                    ctx["errorKind"] = _error_kind(values["error"])
                if values.get("outcome") == "disconnected":
                    ctx["cancelled"] = True
            if capture_control is not None:
                with capture_control.lock:
                    if not capture_control.allowed_record(self):
                        return
                    return handler_note(self, **values)
            return handler_note(self, **values)

        @functools.wraps(emit_json)
        def observed_json(self, code, obj, headers=None, retry_after=None):
            # 0.1.43.1 adds optional headers for retryable 503s and 0.2.0 adds
            # retry_after for 429/503. Older reviewed handlers take fewer
            # arguments, so forward only what the upstream caller supplied.
            def emit():
                extra = {}
                if headers is not None:
                    extra["headers"] = headers
                if retry_after is not None:
                    extra["retry_after"] = retry_after
                return emit_json(self, code, obj, **extra)

            ctx = getattr(self, "_manager_context", None)
            if ctx and isinstance(obj, dict):
                _usage(ctx, obj.get("usage"))
                if obj.get("error"):
                    ctx["errorKind"] = _error_kind(obj["error"])
                if ctx["route"] == "token_count":
                    # Token-count requests do not perform inference or consume tokens.
                    ctx["countedTokens"] = _number(obj.get("input_tokens"), True)
            if capture_control is not None:
                detached = None
                with capture_control.lock:
                    capture_control.allowed_record(self)
                    record = getattr(self, "record", None)
                    if record is not None and record.get("_manager_capture_token"):
                        with svc.status_lock:
                            raw = json.dumps(obj, ensure_ascii=False, indent=2)
                            record.update(http_status=code, response=raw[:262144], response_truncated=len(raw) > 262144)
                            for key in ("error", "usage", "timings"):
                                if key in obj:
                                    record[key] = obj[key]
                        self.record = None
                        detached = record
                try:
                    return emit()
                finally:
                    # Restore lifecycle bookkeeping for the upstream finally;
                    # all later capture writes still validate this exact lease.
                    if detached is not None:
                        self.record = detached
            return emit()

        @functools.wraps(capture)
        def observed_capture(self, items, api):
            record = getattr(self, "record", None)
            temporary = record is not None and record.get("_manager_capture_token")
            # Never hold the capture lock while awaiting the engine's next token.
            # Otherwise a slow stream could prevent the TTL thread from erasing.
            original = items if temporary else capture(self, items, api)
            try:
                for item in original:
                    if temporary and item is not None:
                        with capture_control.lock:
                            if capture_control.allowed_record(self) and self.record is not None:
                                if api == "openai":
                                    delta = item["choices"][0]["delta"]
                                    content, reasoning = delta.get("content", ""), delta.get("reasoning_content", "")
                                    usage, timings = item.get("usage"), item.get("timings")
                                elif api == "responses":
                                    content = item["delta"] if item["type"] == "response.output_text.delta" else ""
                                    reasoning = item["delta"] if item["type"] == "response.reasoning_text.delta" else ""
                                    usage, timings = (item.get("response") or {}).get("usage"), None
                                else:
                                    _, event = item
                                    delta = event.get("delta", {})
                                    content, reasoning = delta.get("text", ""), delta.get("thinking", "")
                                    usage, timings = event.get("usage"), None
                                with svc.status_lock:
                                    for name, value in (("output", content), ("reasoning", reasoning)):
                                        if value:
                                            combined = self.record[name] + value
                                            self.record[name] = combined[:262144]
                                            self.record[name + "_truncated"] |= len(combined) > 262144
                                    if usage:
                                        self.record["usage"] = usage
                                    if timings:
                                        self.record["timings"] = timings
                    _inspect_item(getattr(self, "_manager_context", None), item, api)
                    yield item
            finally:
                original.close()

        handler.do_POST, handler.send_response, handler._note = observed_post, observed_send, observed_note
        handler.do_GET = observed_get
        handler._json, handler._capture = observed_json, observed_capture
        return handler

    namespace["make_handler"] = observed_handler
    stopped = threading.Event()

    def heartbeat():
        last_status = time.monotonic()
        while not stopped.wait(0.5):
            if journal.closed:
                return
            for control in list(_captures):
                if control.journal is journal:
                    control.refresh(force=True)
            if time.monotonic() - last_status >= 30:
                journal.status(not journal.failed, source_hash,
                               "journal_write_failed" if journal.failed else None)
                last_status = time.monotonic()

    def finish_session():
        stopped.set()
        for control in list(_captures):
            if control.journal is journal and control.svc() is not None:
                with control.lock:
                    control.erase(control.svc())
        journal.append("session_end", {"sessionId": journal.session_id,
                       "serviceId": journal.service_id, "endedAtMs": int(time.time()*1000)})
        if not journal.closed:
            journal.status(False, source_hash)

    threading.Thread(target=heartbeat, daemon=True, name="strata-analytics-heartbeat").start()
    atexit.register(finish_session)


class _ObservedLoader(importlib.abc.Loader):
    def __init__(self, loader, fullname):
        self.loader, self.fullname = loader, fullname

    def create_module(self, spec):
        return self.loader.create_module(spec) if hasattr(self.loader, "create_module") else None

    def get_code(self, fullname):
        source = self.loader.get_source(fullname)
        filename = self.loader.get_filename(fullname)
        digest = hashlib.sha256(Path(filename).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
        tree = ast.parse(source, filename)
        analysis = None if digest in SUPPORTED_HASHES else analyze_source(source)
        hook = ast.parse("__import__('strata_observer').instrument_globals(globals(), source_hash="
                         + repr(digest) + ", analysis=" + repr(analysis) + ")").body[0]
        # Inject before the guard, after Service/make_handler definitions, keeping
        # -m argv and upstream __name__/__file__/relative imports unchanged.
        index = next((i for i, node in enumerate(tree.body) if isinstance(node, ast.If)
                      and isinstance(node.test, ast.Compare)
                      and isinstance(node.test.left, ast.Name) and node.test.left.id == "__name__"), len(tree.body))
        tree.body.insert(index, hook)
        ast.fix_missing_locations(tree)
        return compile(tree, filename, "exec")

    def get_source(self, fullname):
        return self.loader.get_source(fullname)

    def get_filename(self, fullname):
        return self.loader.get_filename(fullname)

    def is_package(self, fullname):
        return False

    def exec_module(self, module):
        exec(self.get_code(self.fullname), module.__dict__)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname != "serve.server":
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and spec.loader and hasattr(spec.loader, "get_source"):
            spec.loader = _ObservedLoader(spec.loader, fullname)
        return spec


def install():
    global _journal
    directory = os.environ.get("STRATA_MANAGER_ANALYTICS_DIR")
    service_id = os.environ.get("STRATA_MANAGER_SERVICE_ID", "")
    if not directory or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", service_id):
        return
    try:
        _journal = Journal(directory, service_id)
        sys.meta_path.insert(0, _Finder())
    except (sqlite3.Error, OSError):
        print("[strata-manager] analytics could not start; API remains unchanged", file=sys.stderr, flush=True)


if __name__ == "sitecustomize":
    install()
