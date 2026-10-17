-- Benchmark Arena schema v1. Only whitelisted, non-identifying fields are stored.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  install_hash TEXT NOT NULL,          -- sha256(installId); the raw installId never leaves the request
  received_at INTEGER NOT NULL,        -- server time, ms
  day TEXT NOT NULL,                   -- client run date (YYYY-MM-DD)
  schema_version INTEGER NOT NULL,
  consent_version INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  strata_version TEXT,
  kind TEXT NOT NULL,                  -- context | scenario
  os TEXT NOT NULL, arch TEXT NOT NULL, cpu TEXT NOT NULL, ram_gb INTEGER NOT NULL, wsl INTEGER NOT NULL,
  gpu_vendor TEXT, gpu_name TEXT, gpu_count INTEGER NOT NULL, vram_gb INTEGER NOT NULL, pcie TEXT,
  family TEXT NOT NULL, quant TEXT NOT NULL, model_sha256 TEXT, model_size_gb REAL,
  ctx INTEGER NOT NULL, kv TEXT NOT NULL, parallel INTEGER NOT NULL, pool_workers INTEGER, expert_cache TEXT, pcie_frac REAL, vision INTEGER NOT NULL,
  decode_8k REAL, prefill_8k REAL, ttft_8k_ms REAL, decode_32k REAL, decode_128k REAL,
  peak_vram_gb REAL, peak_ram_gb REAL,
  result_json TEXT NOT NULL,           -- validated tiers/scenario summary only
  seed INTEGER NOT NULL DEFAULT 0,     -- maintainer seed data, shown separately
  hidden INTEGER NOT NULL DEFAULT 0    -- maintainer moderation
);
CREATE INDEX IF NOT EXISTS submissions_install ON submissions(install_hash);
CREATE INDEX IF NOT EXISTS submissions_group ON submissions(family, quant, kind);
CREATE INDEX IF NOT EXISTS submissions_received ON submissions(received_at);
-- Short-lived counters. Keys are hashes (installId hash or daily-salted IP HMAC); rows are purged after two days.
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, window TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window));
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aggregates (key TEXT PRIMARY KEY, json TEXT NOT NULL, computed_at INTEGER NOT NULL);
