-- Benchmark Arena schema v2: per-install Ed25519 keys and server-side reputation.
-- An install is identified only by its random public key; key_id = sha256(public key bytes).
CREATE TABLE IF NOT EXISTS installs (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,            -- 32-byte Ed25519 public key, hex
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  pow_bits INTEGER NOT NULL,           -- difficulty solved at registration
  override TEXT,                       -- maintainer decision: 'ban' | 'trust' | NULL
  status TEXT NOT NULL DEFAULT 'probation', -- computed: probation | trusted | flagged | banned
  trust REAL NOT NULL DEFAULT 0,       -- computed 0..1
  runs INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  consistent INTEGER NOT NULL DEFAULT 0,
  compared INTEGER NOT NULL DEFAULT 0,
  corroborated INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER
);
CREATE INDEX IF NOT EXISTS installs_registered ON installs(registered_at);
-- Per-run plausibility flag set by the reputation pass; flagged runs never enter aggregates.
ALTER TABLE submissions ADD COLUMN flag TEXT;
-- Submissions from before per-install keys cannot be attributed to a key; they are dropped.
DELETE FROM submissions;
